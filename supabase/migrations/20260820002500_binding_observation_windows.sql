begin;

-- ---------------------------------------------------------------------------
-- Governed observation windows for KPI bindings
--
-- Tiles like Revenue MTD must observe calendar-aligned periods, not trailing
-- cadence windows. This migration adds a governed per-binding observation
-- window with exactly three values:
--   trailing — the existing behavior: now - cadence → now (default),
--   today    — local midnight → now, in the bound location's timezone,
--   mtd      — local first-of-month midnight → now, in the location timezone.
--
-- Guarantees preserved:
--   1. Fingerprint back-compat: a 'trailing' binding produces a byte-identical
--      canonical fingerprint to the pre-migration contract, so every existing
--      approved binding remains archivable and its observations remain valid.
--      Non-trailing windows extend the fingerprint payload and therefore
--      require a fresh draft + trusted operator approval.
--   2. Exact-location uniqueness now applies to non-archived bindings only, so
--      an approved contract can be archived and superseded by a new draft with
--      different window semantics without deleting audit history.
--   3. The worker owns all period math; the scheduler RPCs only expose the
--      governed window and the location timezone alongside each due binding.
-- ---------------------------------------------------------------------------

alter table public.custom_kpi_location_bindings
  add column observation_window text not null default 'trailing'
  check (observation_window in ('trailing', 'today', 'mtd'));

comment on column public.custom_kpi_location_bindings.observation_window is
  'Governed observation period shape: trailing cadence window, local calendar day, or local month-to-date. Non-trailing windows are part of the canonical fingerprint and require trusted re-approval.';

alter table public.original_kpi_catalog
  add column default_observation_window text not null default 'trailing'
  check (default_observation_window in ('trailing', 'today', 'mtd'));

comment on column public.original_kpi_catalog.default_observation_window is
  'Default observation window stamped on generated draft bindings for this catalog KPI.';

-- Calendar-aligned defaults for catalog KPIs whose business meaning is
-- month-to-date or today. Everything else stays trailing.
update public.original_kpi_catalog
set default_observation_window = 'mtd'
where catalog_version = 1
  and kpi_key in (
    'revenue-mtd', 'hvac-revenue', 'plumbing-revenue', 'electrical-revenue',
    'avg-ticket', 'hvac-ticket',
    'sales-close', 'hvac-close', 'plumbing-close', 'hvac-maintenance-close'
  );

update public.original_kpi_catalog
set default_observation_window = 'today'
where catalog_version = 1
  and kpi_key in ('booking-rate', 'calls-booked', 'calls-not-booked', 'hvac-service-appts');

-- ---------------------------------------------------------------------------
-- Exact-location uniqueness: active contracts only.
-- Archived bindings remain as immutable audit history; only one non-archived
-- binding may exist per organization + KPI definition + location.
-- ---------------------------------------------------------------------------

alter table public.custom_kpi_location_bindings
  drop constraint custom_kpi_binding_exact_location_unique;

create unique index custom_kpi_binding_exact_location_active_unique
  on public.custom_kpi_location_bindings (organization_id, kpi_definition_id, location_id)
  where approval_status <> 'archived';

-- ---------------------------------------------------------------------------
-- Fingerprint trigger: include the observation window in the canonical
-- contract for non-trailing windows only, keeping trailing digests identical
-- to the pre-migration contract.
-- ---------------------------------------------------------------------------

create or replace function public.set_and_validate_kpi_binding_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  definition_type text;
  report_fingerprint text;
  custom_endpoint_fingerprint text;
  domo_fingerprint text;
begin
  select definition.type into definition_type
  from public.custom_kpi_definitions definition
  where definition.id = new.kpi_definition_id and definition.organization_id = new.organization_id;

  if definition_type is null then
    raise exception 'Unknown KPI definition for location binding';
  end if;
  if definition_type = 'service_titan'
     and (new.source_method is null or new.source_method = 'domo_dataset') then
    raise exception 'ServiceTitan KPI location bindings require an endpoint recipe, saved report, or custom endpoint source';
  end if;
  if new.source_method = 'domo_dataset' and definition_type <> 'external' then
    raise exception 'Domo dataset bindings require an external KPI definition';
  end if;
  if definition_type not in ('service_titan', 'external') and new.source_method is not null then
    raise exception 'Only ServiceTitan and external KPI definitions may use provider source bindings';
  end if;
  if definition_type = 'external' and new.source_method is not null and new.source_method <> 'domo_dataset' then
    raise exception 'External KPI definitions may only bind Domo dataset sources';
  end if;

  if new.observation_window <> 'trailing' and new.source_method is null then
    raise exception 'Calendar observation windows require a configured source method';
  end if;

  if new.source_method = 'endpoint_recipe'
     and not public.is_endpoint_recipe_refresh_allowed(
       new.endpoint_recipe_id,
       new.endpoint_recipe_version,
       new.refresh_interval
     ) then
    raise exception 'Refresh interval % is not allowed for ServiceTitan endpoint recipe % version %',
      new.refresh_interval, new.endpoint_recipe_id, new.endpoint_recipe_version;
  end if;

  if new.source_method in ('endpoint_recipe', 'saved_report', 'custom_endpoint') and not exists (
    select 1 from public.service_titan_connection_locations assignment
    where assignment.organization_id = new.organization_id
      and assignment.connection_id = new.connection_id
      and assignment.location_id = new.location_id
      and assignment.revoked_at is null
  ) then
    raise exception 'The exact active ServiceTitan connection-to-location assignment is required';
  end if;

  if new.source_method = 'saved_report' then
    select source.canonical_source_fingerprint into report_fingerprint
    from public.service_titan_report_sources source
    where source.id = new.report_source_id
      and source.organization_id = new.organization_id
      and source.connection_id = new.connection_id
      and source.service_titan_tenant_id = new.service_titan_tenant_id;
    if report_fingerprint is null then
      raise exception 'Saved-report binding identity does not match its organization, connection, and tenant';
    end if;
  end if;

  if new.source_method = 'custom_endpoint' then
    select source.canonical_source_fingerprint into custom_endpoint_fingerprint
    from public.service_titan_custom_endpoint_sources source
    where source.id = new.custom_endpoint_source_id
      and source.organization_id = new.organization_id
      and source.connection_id = new.connection_id
      and source.service_titan_tenant_id = new.service_titan_tenant_id
      and source.status = 'active';
    if custom_endpoint_fingerprint is null then
      raise exception 'Custom endpoint binding identity does not match an active source for this organization, connection, and tenant';
    end if;
  end if;

  if new.source_method = 'domo_dataset' then
    select source.canonical_source_fingerprint into domo_fingerprint
    from public.domo_dataset_sources source
    where source.id = new.domo_dataset_source_id
      and source.organization_id = new.organization_id
      and source.domo_connection_id = new.domo_connection_id
      and source.status = 'active';
    if domo_fingerprint is null then
      raise exception 'Domo dataset binding identity does not match an active source for this organization and connection';
    end if;
  end if;

  if new.source_method is null then
    new.canonical_source_fingerprint := null;
  else
    new.canonical_source_fingerprint := public.canonical_source_fingerprint(
      pg_catalog.jsonb_build_object(
        'organizationId', new.organization_id,
        'kpiDefinitionId', new.kpi_definition_id,
        'locationId', new.location_id,
        'connectionId', new.connection_id,
        'tenantId', new.service_titan_tenant_id,
        'method', new.source_method,
        'recipeId', new.endpoint_recipe_id,
        'recipeVersion', new.endpoint_recipe_version,
        'reportSourceId', new.report_source_id,
        'reportFingerprint', report_fingerprint,
        'customEndpointSourceId', new.custom_endpoint_source_id,
        'customEndpointFingerprint', custom_endpoint_fingerprint,
        'domoConnectionId', new.domo_connection_id,
        'domoDatasetSourceId', new.domo_dataset_source_id,
        'domoDatasetFingerprint', domo_fingerprint,
        'refreshInterval', new.refresh_interval,
        'parameterValues', new.parameter_values,
        'businessUnitMappings', new.business_unit_mappings,
        'reduction', new.report_reduction,
        'valueField', new.value_field,
        'numeratorField', new.numerator_field,
        'denominatorField', new.denominator_field
      )
      || case
           when new.observation_window = 'trailing' then '{}'::jsonb
           else pg_catalog.jsonb_build_object('observationWindow', new.observation_window)
         end
    );
  end if;
  return new;
end;
$$;
revoke all on function public.set_and_validate_kpi_binding_fingerprint() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduling RPCs: expose the governed window and location timezone. The
-- return signature changes, so the old functions are dropped first and the
-- service-role-only grants are re-established.
-- ---------------------------------------------------------------------------

drop function if exists public.get_due_endpoint_bindings(integer);
create or replace function public.get_due_endpoint_bindings(p_limit integer default 50)
returns table (
  organization_id uuid,
  binding_id uuid,
  connection_id uuid,
  service_titan_tenant_id text,
  endpoint_recipe_id text,
  endpoint_recipe_version integer,
  refresh_interval text,
  observation_window text,
  location_timezone text,
  business_unit_mappings jsonb,
  location_id uuid,
  kpi_definition_id uuid,
  canonical_source_fingerprint text,
  last_period_end timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    binding.organization_id,
    binding.id as binding_id,
    binding.connection_id,
    binding.service_titan_tenant_id,
    binding.endpoint_recipe_id,
    binding.endpoint_recipe_version,
    binding.refresh_interval,
    binding.observation_window,
    location.timezone as location_timezone,
    binding.business_unit_mappings,
    binding.location_id,
    binding.kpi_definition_id,
    binding.canonical_source_fingerprint,
    (
      select pg_catalog.max(observation.period_end)
      from public.kpi_observations observation
      where observation.organization_id = binding.organization_id
        and observation.binding_id = binding.id
        and observation.status = 'valid'
        and observation.source_fingerprint = binding.canonical_source_fingerprint
    ) as last_period_end
  from public.custom_kpi_location_bindings binding
  join public.organizations organization
    on organization.id = binding.organization_id and organization.status = 'active'
  join public.custom_kpi_definitions definition
    on definition.organization_id = binding.organization_id
   and definition.id = binding.kpi_definition_id
   and definition.lifecycle = 'published'
  join public.locations location
    on location.organization_id = binding.organization_id
   and location.id = binding.location_id
   and location.status = 'active'
  join public.service_titan_connections connection
    on connection.organization_id = binding.organization_id
   and connection.id = binding.connection_id
   and connection.service_titan_tenant_id = binding.service_titan_tenant_id
   and connection.status = 'ready'
  join public.service_titan_connection_locations assignment
    on assignment.organization_id = binding.organization_id
   and assignment.connection_id = binding.connection_id
   and assignment.location_id = binding.location_id
   and assignment.revoked_at is null
  where binding.source_method = 'endpoint_recipe'
    and binding.approval_status = 'approved'
    and coalesce(
      (
        select pg_catalog.max(observation.period_end)
        from public.kpi_observations observation
        where observation.organization_id = binding.organization_id
          and observation.binding_id = binding.id
          and observation.status = 'valid'
          and observation.source_fingerprint = binding.canonical_source_fingerprint
      ),
      'epoch'::timestamptz
    ) <= pg_catalog.now() - case binding.refresh_interval
      when '15m' then interval '15 minutes'
      when '30m' then interval '30 minutes'
      when '1h' then interval '1 hour'
      when '4h' then interval '4 hours'
      when '12h' then interval '12 hours'
      else interval '24 hours'
    end
  order by last_period_end nulls first
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.get_due_endpoint_bindings(integer) from public, anon, authenticated;
grant execute on function public.get_due_endpoint_bindings(integer) to service_role;
comment on function public.get_due_endpoint_bindings(integer) is
  'Service-role scheduling surface: approved endpoint-recipe bindings whose cadence elapsed, with the governed observation window and location timezone. The worker owns period math.';

drop function if exists public.get_due_custom_endpoint_bindings(integer);
create or replace function public.get_due_custom_endpoint_bindings(p_limit integer default 50)
returns table (
  organization_id uuid,
  binding_id uuid,
  connection_id uuid,
  service_titan_tenant_id text,
  custom_endpoint_source_id uuid,
  refresh_interval text,
  observation_window text,
  location_timezone text,
  business_unit_mappings jsonb,
  location_id uuid,
  kpi_definition_id uuid,
  canonical_source_fingerprint text,
  last_period_end timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    binding.organization_id,
    binding.id as binding_id,
    binding.connection_id,
    binding.service_titan_tenant_id,
    binding.custom_endpoint_source_id,
    binding.refresh_interval,
    binding.observation_window,
    location.timezone as location_timezone,
    binding.business_unit_mappings,
    binding.location_id,
    binding.kpi_definition_id,
    binding.canonical_source_fingerprint,
    (
      select pg_catalog.max(observation.period_end)
      from public.kpi_observations observation
      where observation.organization_id = binding.organization_id
        and observation.binding_id = binding.id
        and observation.status = 'valid'
        and observation.source_fingerprint = binding.canonical_source_fingerprint
    ) as last_period_end
  from public.custom_kpi_location_bindings binding
  join public.organizations organization
    on organization.id = binding.organization_id and organization.status = 'active'
  join public.custom_kpi_definitions definition
    on definition.organization_id = binding.organization_id
   and definition.id = binding.kpi_definition_id
   and definition.lifecycle = 'published'
  join public.locations location
    on location.organization_id = binding.organization_id
   and location.id = binding.location_id
   and location.status = 'active'
  join public.service_titan_connections connection
    on connection.organization_id = binding.organization_id
   and connection.id = binding.connection_id
   and connection.service_titan_tenant_id = binding.service_titan_tenant_id
   and connection.status = 'ready'
  join public.service_titan_connection_locations assignment
    on assignment.organization_id = binding.organization_id
   and assignment.connection_id = binding.connection_id
   and assignment.location_id = binding.location_id
   and assignment.revoked_at is null
  join public.service_titan_custom_endpoint_sources source
    on source.organization_id = binding.organization_id
   and source.id = binding.custom_endpoint_source_id
   and source.lifecycle = 'approved'
   and source.status = 'active'
  where binding.source_method = 'custom_endpoint'
    and binding.approval_status = 'approved'
    and binding.approved_custom_endpoint_fingerprint = source.canonical_source_fingerprint
    and coalesce(
      (
        select pg_catalog.max(observation.period_end)
        from public.kpi_observations observation
        where observation.organization_id = binding.organization_id
          and observation.binding_id = binding.id
          and observation.status = 'valid'
          and observation.source_fingerprint = binding.canonical_source_fingerprint
      ),
      'epoch'::timestamptz
    ) <= pg_catalog.now() - case binding.refresh_interval
      when '1h' then interval '1 hour'
      when '4h' then interval '4 hours'
      when '12h' then interval '12 hours'
      else interval '24 hours'
    end
  order by last_period_end nulls first
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.get_due_custom_endpoint_bindings(integer) from public, anon, authenticated;
grant execute on function public.get_due_custom_endpoint_bindings(integer) to service_role;

drop function if exists public.get_due_domo_bindings(integer);
create or replace function public.get_due_domo_bindings(p_limit integer default 50)
returns table (
  organization_id uuid,
  binding_id uuid,
  domo_connection_id uuid,
  domo_dataset_source_id uuid,
  refresh_interval text,
  observation_window text,
  location_timezone text,
  location_id uuid,
  kpi_definition_id uuid,
  canonical_source_fingerprint text,
  last_period_end timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    binding.organization_id,
    binding.id as binding_id,
    binding.domo_connection_id,
    binding.domo_dataset_source_id,
    binding.refresh_interval,
    binding.observation_window,
    location.timezone as location_timezone,
    binding.location_id,
    binding.kpi_definition_id,
    binding.canonical_source_fingerprint,
    (
      select pg_catalog.max(observation.period_end)
      from public.kpi_observations observation
      where observation.organization_id = binding.organization_id
        and observation.binding_id = binding.id
        and observation.status = 'valid'
        and observation.source_fingerprint = binding.canonical_source_fingerprint
    ) as last_period_end
  from public.custom_kpi_location_bindings binding
  join public.organizations organization
    on organization.id = binding.organization_id and organization.status = 'active'
  join public.custom_kpi_definitions definition
    on definition.organization_id = binding.organization_id
   and definition.id = binding.kpi_definition_id
   and definition.lifecycle = 'published'
  join public.locations location
    on location.organization_id = binding.organization_id
   and location.id = binding.location_id
   and location.status = 'active'
  join public.domo_connections connection
    on connection.organization_id = binding.organization_id
   and connection.id = binding.domo_connection_id
   and connection.status = 'ready'
  join public.domo_dataset_sources source
    on source.organization_id = binding.organization_id
   and source.id = binding.domo_dataset_source_id
   and source.lifecycle = 'approved'
   and source.status = 'active'
  where binding.source_method = 'domo_dataset'
    and binding.approval_status = 'approved'
    and binding.approved_domo_dataset_fingerprint = source.canonical_source_fingerprint
    and coalesce(
      (
        select pg_catalog.max(observation.period_end)
        from public.kpi_observations observation
        where observation.organization_id = binding.organization_id
          and observation.binding_id = binding.id
          and observation.status = 'valid'
          and observation.source_fingerprint = binding.canonical_source_fingerprint
      ),
      'epoch'::timestamptz
    ) <= pg_catalog.now() - case binding.refresh_interval
      when '4h' then interval '4 hours'
      when '12h' then interval '12 hours'
      else interval '24 hours'
    end
  order by last_period_end nulls first
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.get_due_domo_bindings(integer) from public, anon, authenticated;
grant execute on function public.get_due_domo_bindings(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Draft auto-binding: stamp the catalog default window and permit
-- regeneration for pairs whose only existing binding is archived.
-- ---------------------------------------------------------------------------

create or replace function public.generate_catalog_recipe_bindings(
  p_organization_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  inserted_count integer;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid()
    and membership.status = 'active' and organization.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;

  -- One draft binding per (published catalog KPI with a wired recipe) ×
  -- (active location assigned to a ready connection). Pairs with any
  -- non-archived binding are never touched; archived history does not block
  -- regeneration.
  insert into public.custom_kpi_location_bindings (
    organization_id, kpi_definition_id, location_id, connection_id,
    service_titan_tenant_id, source_method, endpoint_recipe_id,
    endpoint_recipe_version, refresh_interval, observation_window, approval_status
  )
  select distinct on (definition.id, location.id)
    p_organization_id, definition.id, location.id, connection.id,
    connection.service_titan_tenant_id, 'endpoint_recipe',
    catalog.endpoint_recipe_id, catalog.endpoint_recipe_version,
    case
      when exists (
        select 1 from public.service_titan_endpoint_recipe_refresh_policies policy
        where policy.endpoint_recipe_id = catalog.endpoint_recipe_id
          and policy.endpoint_recipe_version = catalog.endpoint_recipe_version
          and policy.refresh_interval = catalog.default_refresh_cadence
      ) then catalog.default_refresh_cadence
      else '1h'
    end,
    catalog.default_observation_window,
    'draft'
  from public.custom_kpi_definitions definition
  join public.original_kpi_catalog catalog
    on catalog.catalog_version = 1
    and catalog.kpi_key = definition.kpi_key
    and catalog.endpoint_recipe_id is not null
    and catalog.endpoint_recipe_version is not null
  join public.locations location
    on location.organization_id = p_organization_id and location.status = 'active'
  join public.service_titan_connection_locations assignment
    on assignment.organization_id = p_organization_id
    and assignment.location_id = location.id
    and assignment.revoked_at is null
  join public.service_titan_connections connection
    on connection.id = assignment.connection_id
    and connection.organization_id = p_organization_id
    and connection.status = 'ready'
    and connection.last_validated_at is not null
  where definition.organization_id = p_organization_id
    and definition.type = 'service_titan'
    and definition.lifecycle = 'published'
    and definition.external_source ->> 'catalogName' = 'original'
    and not exists (
      select 1 from public.custom_kpi_location_bindings existing
      where existing.organization_id = p_organization_id
        and existing.kpi_definition_id = definition.id
        and existing.location_id = location.id
        and existing.approval_status <> 'archived'
    )
  order by definition.id, location.id, connection.last_validated_at desc, connection.id;
  get diagnostics inserted_count = row_count;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'catalog_recipe_bindings.generate',
    'custom_kpi_location_bindings', null, null,
    pg_catalog.jsonb_build_object('insertedDraftCount', inserted_count),
    pg_catalog.current_setting('request.id', true)
  );
  return inserted_count;
end;
$$;

revoke all on function public.generate_catalog_recipe_bindings(uuid) from public, anon;
grant execute on function public.generate_catalog_recipe_bindings(uuid) to authenticated, service_role;
comment on function public.generate_catalog_recipe_bindings(uuid) is
  'Tenant admin RPC: creates draft endpoint-recipe bindings for every published original-catalog KPI with a wired recipe, across active locations assigned to ready connections. Stamps the catalog default observation window. Drafts still require trusted operator approval before ingestion.';

insert into public.schema_releases (release_marker)
values ('20260820002500_binding_observation_windows');

create or replace function public.get_observation_window_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'custom_kpi_location_bindings'
        and column_name = 'observation_window'
    )
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'original_kpi_catalog'
          and column_name = 'default_observation_window'
      )
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and default_observation_window = 'mtd') = 10
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and default_observation_window = 'today') = 4
      and exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public'
          and indexname = 'custom_kpi_binding_exact_location_active_unique'
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002500_binding_observation_windows'
      ) as ready,
    '20260820002500_binding_observation_windows'::text as release_marker;
$$;
revoke all on function public.get_observation_window_release_readiness() from public;
grant execute on function public.get_observation_window_release_readiness() to anon, authenticated, service_role;

commit;
