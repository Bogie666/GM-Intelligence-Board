-- 021: Governed Domo dataset integration.
-- Domo joins ServiceTitan as a first-class provider for historical/financial KPIs:
--   1. domo_connections — per-tenant Domo OAuth clients stored in Supabase Vault
--      (registered, rotated, disabled through security-definer RPCs; never readable).
--   2. domo_dataset_sources — tenant-declared dataset contracts (dataset GUID,
--      value column, reduction, optional date/filter columns) with the standard
--      declared -> inspected -> approved lifecycle and fingerprint pinning.
--   3. custom_kpi_location_bindings gains source_method = 'domo_dataset' for
--      KPI definitions of type 'external'; observations flow through the same
--      authoritative kpi_observations gate.

begin;

-- ---------- Domo connections (Vault-backed) ----------

create table public.domo_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  display_name text not null,
  secret_reference text not null,
  status text not null default 'needs_attention' check (status in ('needs_attention', 'ready', 'disabled', 'archived')),
  configuration_revision uuid not null default extensions.gen_random_uuid(),
  last_validated_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint domo_connections_name_not_blank check (pg_catalog.btrim(display_name) <> '' and pg_catalog.length(display_name) <= 200),
  constraint domo_connections_secret_reference_shape check (
    secret_reference ~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint domo_connections_org_id_unique unique (organization_id, id)
);

create index domo_connections_org_idx on public.domo_connections (organization_id, status);

alter table public.domo_connections enable row level security;
revoke all on table public.domo_connections from public, anon, authenticated;
grant select (id, organization_id, display_name, status, last_validated_at, last_error_code, created_at, updated_at)
  on public.domo_connections to authenticated;
create policy domo_connections_admin_read on public.domo_connections
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

comment on table public.domo_connections is
  'Per-tenant Domo OAuth clients. Credentials live in Supabase Vault; the secret_reference column is never selectable by tenants.';

create or replace function public.register_domo_connection_with_credentials(
  p_organization_id uuid,
  p_display_name text,
  p_client_id text,
  p_client_secret text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  new_connection_id uuid := extensions.gen_random_uuid();
  vault_secret_id uuid;
  vault_payload text;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;

  select membership.role into actor_role
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid()
    and membership.status = 'active'
    and organization.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'tenant owner or admin membership required' using errcode = '42501';
  end if;

  if p_display_name is null or pg_catalog.btrim(p_display_name) = ''
     or pg_catalog.length(p_display_name) > 200 then
    raise exception 'Domo connection display name is invalid' using errcode = '22023';
  end if;
  if p_client_id is null or pg_catalog.length(p_client_id) not between 8 and 4096
     or p_client_id <> pg_catalog.btrim(p_client_id) or p_client_id ~ '[[:cntrl:]]' then
    raise exception 'Domo client ID is invalid' using errcode = '22023';
  end if;
  if p_client_secret is null or pg_catalog.length(p_client_secret) not between 8 and 4096
     or p_client_secret <> pg_catalog.btrim(p_client_secret) or p_client_secret ~ '[[:cntrl:]]' then
    raise exception 'Domo client secret is invalid' using errcode = '22023';
  end if;

  vault_payload := pg_catalog.jsonb_build_object(
    'clientId', p_client_id,
    'clientSecret', p_client_secret
  )::text;

  vault_secret_id := vault.create_secret(
    vault_payload,
    'gm-intelligence-domo-' || new_connection_id::text,
    'GM Intelligence encrypted Domo credential for connection ' || new_connection_id::text,
    null
  );

  insert into public.domo_connections (
    id, organization_id, display_name, secret_reference, status
  ) values (
    new_connection_id, p_organization_id, pg_catalog.btrim(p_display_name),
    'supabase-vault://' || vault_secret_id::text, 'needs_attention'
  );

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'domo.connection.register',
    'domo_connections', new_connection_id, null,
    pg_catalog.jsonb_build_object('displayName', pg_catalog.btrim(p_display_name)),
    pg_catalog.current_setting('request.id', true)
  );

  return new_connection_id;
end;
$$;
revoke all on function public.register_domo_connection_with_credentials(uuid, text, text, text)
  from public, anon, service_role;
grant execute on function public.register_domo_connection_with_credentials(uuid, text, text, text) to authenticated;

create or replace function public.resolve_domo_connection_secret(
  p_organization_id uuid,
  p_connection_id uuid,
  p_purpose text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reference text;
  secret_id uuid;
  resolved_secret text;
  expected_name text := 'gm-intelligence-domo-' || p_connection_id::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_purpose not in ('validation', 'ingestion') then
    raise exception 'credential access purpose is invalid' using errcode = '22023';
  end if;

  select connection.secret_reference into reference
  from public.domo_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived');

  if reference is null then
    raise exception 'connection does not use a resolvable Vault credential' using errcode = '22023';
  end if;

  secret_id := pg_catalog.replace(reference, 'supabase-vault://', '')::uuid;
  select secret.decrypted_secret into resolved_secret
  from vault.decrypted_secrets secret
  where secret.id = secret_id
    and secret.name = expected_name;

  if resolved_secret is null then
    raise exception 'managed Vault credential is unavailable' using errcode = 'P0002';
  end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, null, 'domo.secret.resolve.' || p_purpose,
    'domo_connections', p_connection_id, null, null,
    pg_catalog.current_setting('request.id', true)
  );

  return resolved_secret;
end;
$$;
revoke all on function public.resolve_domo_connection_secret(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_domo_connection_secret(uuid, uuid, text) to service_role;

create or replace function public.set_domo_connection_status(
  p_organization_id uuid,
  p_connection_id uuid,
  p_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_status not in ('ready', 'needs_attention') then
    raise exception 'worker status transition is invalid' using errcode = '22023';
  end if;
  update public.domo_connections connection
  set status = p_status,
      last_validated_at = case when p_status = 'ready' then pg_catalog.clock_timestamp() else connection.last_validated_at end,
      last_error_code = case when p_status = 'ready' then null else pg_catalog.left(p_error_code, 120) end,
      updated_at = pg_catalog.clock_timestamp()
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived');
  return found;
end;
$$;
revoke all on function public.set_domo_connection_status(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_domo_connection_status(uuid, uuid, text, text) to service_role;

create or replace function public.disable_domo_connection(
  p_organization_id uuid,
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid()
    and membership.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'tenant owner or admin membership required' using errcode = '42501';
  end if;

  update public.domo_connections connection
  set status = 'disabled', updated_at = pg_catalog.clock_timestamp()
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived');
  if not found then return false; end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'domo.connection.disable',
    'domo_connections', p_connection_id, null, null,
    pg_catalog.current_setting('request.id', true)
  );
  return true;
end;
$$;
revoke all on function public.disable_domo_connection(uuid, uuid) from public, anon, service_role;
grant execute on function public.disable_domo_connection(uuid, uuid) to authenticated;

-- ---------- Domo dataset sources ----------

create table public.domo_dataset_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  domo_connection_id uuid not null,
  dataset_id text not null,
  name text not null,
  description text not null default '',
  value_column text,
  reduction text not null check (reduction in ('sum', 'average', 'count', 'latest')),
  date_column text,
  filter_column text,
  filter_value text,
  canonical_source_fingerprint text not null default '',
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'inspected', 'approved', 'archived')),
  status text not null default 'active' check (status in ('active', 'archived')),
  inspected_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint domo_dataset_sources_connection_fk foreign key (organization_id, domo_connection_id)
    references public.domo_connections(organization_id, id) on delete restrict,
  constraint domo_dataset_sources_dataset_id_shape check (
    dataset_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint domo_dataset_sources_name_not_blank check (pg_catalog.btrim(name) <> '' and pg_catalog.length(name) <= 200),
  constraint domo_dataset_sources_description_bounded check (pg_catalog.length(description) <= 500),
  constraint domo_dataset_sources_value_column_shape check (
    (reduction = 'count' and value_column is null)
    or (reduction in ('sum', 'average', 'latest') and value_column is not null
        and value_column ~ '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$')
  ),
  constraint domo_dataset_sources_date_column_shape check (
    date_column is null or date_column ~ '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$'
  ),
  constraint domo_dataset_sources_filter_shape check (
    (filter_column is null and filter_value is null)
    or (filter_column is not null and filter_value is not null
        and filter_column ~ '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$'
        and pg_catalog.length(filter_value) between 1 and 200)
  ),
  constraint domo_dataset_sources_lifecycle_status check ((lifecycle = 'archived') = (status = 'archived')),
  constraint domo_dataset_sources_approval_fields check (
    lifecycle <> 'approved'
    or (status = 'active' and approved_at is not null and approved_by is not null)
  ),
  constraint domo_dataset_sources_org_id_unique unique (organization_id, id),
  constraint domo_dataset_sources_binding_identity_unique unique (organization_id, id, domo_connection_id),
  constraint domo_dataset_sources_name_unique unique (organization_id, domo_connection_id, name)
);

create index domo_dataset_sources_org_lifecycle_idx
  on public.domo_dataset_sources (organization_id, lifecycle, status);

comment on table public.domo_dataset_sources is
  'Tenant-declared Domo dataset contracts for governed historical/financial KPI ingestion.';

create or replace function public.set_domo_dataset_source_fingerprint()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.canonical_source_fingerprint := public.canonical_source_fingerprint(
    pg_catalog.jsonb_build_object(
      'organizationId', new.organization_id,
      'domoConnectionId', new.domo_connection_id,
      'datasetId', new.dataset_id,
      'valueColumn', new.value_column,
      'reduction', new.reduction,
      'dateColumn', new.date_column,
      'filterColumn', new.filter_column,
      'filterValue', new.filter_value
    )
  );
  return new;
end;
$$;
revoke all on function public.set_domo_dataset_source_fingerprint() from public, anon, authenticated;

create or replace function public.protect_domo_dataset_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.lifecycle = 'archived' then
    raise exception 'Archived Domo dataset sources are immutable';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.domo_connection_id is distinct from old.domo_connection_id
     or new.dataset_id is distinct from old.dataset_id then
    raise exception 'Domo dataset source organization/connection/dataset identity is immutable';
  end if;
  if old.lifecycle = 'approved' then
    if new.lifecycle not in ('approved', 'archived') then
      raise exception 'Approved Domo dataset sources may only remain approved or be archived';
    end if;
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'status', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'status', 'updated_at']) then
      raise exception 'Approved Domo dataset contracts are immutable; create a new source';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_domo_dataset_source() from public, anon, authenticated;

create trigger domo_dataset_sources_05_protect
before update on public.domo_dataset_sources
for each row execute function public.protect_domo_dataset_source();
create trigger domo_dataset_sources_10_fingerprint
before insert or update on public.domo_dataset_sources
for each row execute function public.set_domo_dataset_source_fingerprint();

alter table public.domo_dataset_sources enable row level security;
revoke all on table public.domo_dataset_sources from public, anon, authenticated;
grant select, insert, update, delete on table public.domo_dataset_sources to authenticated;
create policy domo_dataset_sources_admin_read on public.domo_dataset_sources
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy domo_dataset_sources_admin_insert on public.domo_dataset_sources
for insert to authenticated
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy domo_dataset_sources_admin_update on public.domo_dataset_sources
for update to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy domo_dataset_sources_admin_delete on public.domo_dataset_sources
for delete to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

-- ---------- Binding integration ----------

alter table public.custom_kpi_location_bindings
  add column domo_connection_id uuid,
  add column domo_dataset_source_id uuid,
  add column approved_domo_dataset_fingerprint text;

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_bindings_domo_source_fk
    foreign key (organization_id, domo_dataset_source_id, domo_connection_id)
    references public.domo_dataset_sources(organization_id, id, domo_connection_id)
    on delete restrict;

alter table public.custom_kpi_location_bindings
  drop constraint custom_kpi_binding_source_shape;

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_source_shape check (
    (source_method is null and connection_id is null and service_titan_tenant_id is null
      and endpoint_recipe_id is null and endpoint_recipe_version is null and report_source_id is null
      and custom_endpoint_source_id is null and domo_connection_id is null and domo_dataset_source_id is null
      and refresh_interval is null and report_reduction is null and canonical_source_fingerprint is null)
    or
    (source_method = 'endpoint_recipe' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is not null and pg_catalog.btrim(endpoint_recipe_id) <> ''
      and endpoint_recipe_version is not null and endpoint_recipe_version > 0
      and report_source_id is null and custom_endpoint_source_id is null
      and domo_connection_id is null and domo_dataset_source_id is null
      and refresh_interval is not null and report_reduction is null)
    or
    (source_method = 'saved_report' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is null and endpoint_recipe_version is null
      and report_source_id is not null and custom_endpoint_source_id is null
      and domo_connection_id is null and domo_dataset_source_id is null
      and refresh_interval in ('4h', '12h', '24h') and report_reduction is not null)
    or
    (source_method = 'custom_endpoint' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is null and endpoint_recipe_version is null
      and report_source_id is null and custom_endpoint_source_id is not null
      and domo_connection_id is null and domo_dataset_source_id is null
      and refresh_interval in ('1h', '4h', '12h', '24h') and report_reduction is null)
    or
    (source_method = 'domo_dataset' and connection_id is null and service_titan_tenant_id is null
      and endpoint_recipe_id is null and endpoint_recipe_version is null
      and report_source_id is null and custom_endpoint_source_id is null
      and domo_connection_id is not null and domo_dataset_source_id is not null
      and refresh_interval in ('4h', '12h', '24h') and report_reduction is null)
  );

alter table public.custom_kpi_location_bindings
  drop constraint custom_kpi_location_bindings_source_method_check;
alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_location_bindings_source_method_check
    check (source_method in ('endpoint_recipe', 'saved_report', 'custom_endpoint', 'domo_dataset'));

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_domo_pin_check check (
    (source_method = 'domo_dataset' and approved_domo_dataset_fingerprint is not null
      and pg_catalog.btrim(approved_domo_dataset_fingerprint) <> '')
    or
    (source_method is distinct from 'domo_dataset' and approved_domo_dataset_fingerprint is null)
  );

-- Binding fingerprint trigger now covers all four source methods and the
-- external-definition pathway for Domo.
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
    );
  end if;
  return new;
end;
$$;
revoke all on function public.set_and_validate_kpi_binding_fingerprint() from public, anon, authenticated;

-- Pin trigger covers Domo fingerprints alongside saved-report and custom-endpoint pins.
create or replace function public.pin_and_protect_saved_report_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_source_fingerprint text;
  current_custom_fingerprint text;
  current_domo_fingerprint text;
begin
  if tg_op = 'UPDATE' and old.approval_status = 'archived' then
    raise exception 'Archived KPI bindings are immutable';
  end if;

  if tg_op = 'UPDATE' and old.approval_status = 'approved' then
    if new.approval_status not in ('approved', 'archived') then
      raise exception 'Approved KPI bindings may only remain approved or be archived';
    end if;
    if (pg_catalog.to_jsonb(new) - array['approval_status', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['approval_status', 'updated_at']) then
      raise exception 'Approved KPI bindings are immutable; create a new binding contract';
    end if;
    return new;
  end if;

  if new.source_method = 'saved_report' then
    select source.canonical_source_fingerprint
      into current_source_fingerprint
    from public.service_titan_report_sources source
    where source.id = new.report_source_id
      and source.organization_id = new.organization_id
      and source.connection_id = new.connection_id
      and source.service_titan_tenant_id = new.service_titan_tenant_id;
    if current_source_fingerprint is null then
      raise exception 'Saved-report source fingerprint is unavailable';
    end if;
    new.approved_report_source_fingerprint := current_source_fingerprint;
  else
    new.approved_report_source_fingerprint := null;
  end if;

  if new.source_method = 'custom_endpoint' then
    select source.canonical_source_fingerprint
      into current_custom_fingerprint
    from public.service_titan_custom_endpoint_sources source
    where source.id = new.custom_endpoint_source_id
      and source.organization_id = new.organization_id
      and source.connection_id = new.connection_id
      and source.service_titan_tenant_id = new.service_titan_tenant_id;
    if current_custom_fingerprint is null then
      raise exception 'Custom endpoint source fingerprint is unavailable';
    end if;
    new.approved_custom_endpoint_fingerprint := current_custom_fingerprint;
  else
    new.approved_custom_endpoint_fingerprint := null;
  end if;

  if new.source_method = 'domo_dataset' then
    select source.canonical_source_fingerprint
      into current_domo_fingerprint
    from public.domo_dataset_sources source
    where source.id = new.domo_dataset_source_id
      and source.organization_id = new.organization_id
      and source.domo_connection_id = new.domo_connection_id;
    if current_domo_fingerprint is null then
      raise exception 'Domo dataset source fingerprint is unavailable';
    end if;
    new.approved_domo_dataset_fingerprint := current_domo_fingerprint;
  else
    new.approved_domo_dataset_fingerprint := null;
  end if;
  return new;
end;
$$;
revoke all on function public.pin_and_protect_saved_report_binding() from public, anon, authenticated;

-- Authoritative observation gate: Domo bindings have no ServiceTitan connection or
-- assignment, so the ServiceTitan chain joins become conditional.
create or replace function public.bind_observation_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  governed record;
  governed_source_lifecycle text;
  governed_source_status text;
  governed_source_fingerprint text;
  governed_domo_connection_status text;
begin
  select
    binding.organization_id,
    binding.kpi_definition_id,
    binding.location_id,
    binding.source_method,
    binding.endpoint_recipe_version,
    binding.canonical_source_fingerprint,
    binding.approved_report_source_fingerprint,
    binding.approved_custom_endpoint_fingerprint,
    binding.approved_domo_dataset_fingerprint,
    binding.report_source_id,
    binding.custom_endpoint_source_id,
    binding.domo_connection_id,
    binding.domo_dataset_source_id,
    binding.approval_status,
    definition.lifecycle as definition_lifecycle,
    organization.status as organization_status,
    location.status as location_status,
    connection.status as connection_status,
    assignment.revoked_at,
    (connection.id is not null) as has_st_connection,
    (assignment.connection_id is not null) as has_st_assignment
  into governed
  from public.custom_kpi_location_bindings binding
  join public.organizations organization
    on organization.id = binding.organization_id
  join public.custom_kpi_definitions definition
    on definition.organization_id = binding.organization_id
   and definition.id = binding.kpi_definition_id
  join public.locations location
    on location.organization_id = binding.organization_id
   and location.id = binding.location_id
  left join public.service_titan_connections connection
    on connection.organization_id = binding.organization_id
   and connection.id = binding.connection_id
   and connection.service_titan_tenant_id = binding.service_titan_tenant_id
  left join public.service_titan_connection_locations assignment
    on assignment.organization_id = binding.organization_id
   and assignment.connection_id = binding.connection_id
   and assignment.location_id = binding.location_id
   and assignment.revoked_at is null
  where binding.id = new.binding_id
  for share of binding, definition, location;

  if governed.organization_id is null
     or governed.canonical_source_fingerprint is null then
    raise exception 'Observation requires an exact fingerprinted KPI location binding';
  end if;

  if new.organization_id <> governed.organization_id
     or new.kpi_definition_id <> governed.kpi_definition_id
     or new.location_id <> governed.location_id then
    raise exception 'Observation organization/KPI/location identity does not match its binding';
  end if;

  if new.status = 'valid' then
    if governed.approval_status is distinct from 'approved'
       or governed.definition_lifecycle is distinct from 'published'
       or governed.organization_status is distinct from 'active'
       or governed.location_status is distinct from 'active' then
      raise exception 'Valid observations require a published, approved, active authorization chain';
    end if;

    if governed.source_method in ('endpoint_recipe', 'saved_report', 'custom_endpoint') then
      if not governed.has_st_connection
         or governed.connection_status is distinct from 'ready'
         or not governed.has_st_assignment then
        raise exception 'Valid ServiceTitan observations require a ready connection and active location assignment';
      end if;
    end if;

    if governed.source_method = 'saved_report' then
      select source.lifecycle, source.status, source.canonical_source_fingerprint
        into governed_source_lifecycle, governed_source_status, governed_source_fingerprint
      from public.service_titan_report_sources source
      where source.organization_id = governed.organization_id
        and source.id = governed.report_source_id
      for share;

      if governed_source_lifecycle is distinct from 'approved'
         or governed_source_status is distinct from 'active'
         or governed_source_fingerprint is null
         or governed.approved_report_source_fingerprint is distinct from governed_source_fingerprint then
        raise exception 'Valid saved-report observations require the exact currently approved report source';
      end if;
    elsif governed.source_method = 'custom_endpoint' then
      select source.lifecycle, source.status, source.canonical_source_fingerprint
        into governed_source_lifecycle, governed_source_status, governed_source_fingerprint
      from public.service_titan_custom_endpoint_sources source
      where source.organization_id = governed.organization_id
        and source.id = governed.custom_endpoint_source_id
      for share;

      if governed_source_lifecycle is distinct from 'approved'
         or governed_source_status is distinct from 'active'
         or governed_source_fingerprint is null
         or governed.approved_custom_endpoint_fingerprint is distinct from governed_source_fingerprint then
        raise exception 'Valid custom-endpoint observations require the exact currently approved custom endpoint source';
      end if;
    elsif governed.source_method = 'domo_dataset' then
      select source.lifecycle, source.status, source.canonical_source_fingerprint
        into governed_source_lifecycle, governed_source_status, governed_source_fingerprint
      from public.domo_dataset_sources source
      where source.organization_id = governed.organization_id
        and source.id = governed.domo_dataset_source_id
      for share;

      select connection.status into governed_domo_connection_status
      from public.domo_connections connection
      where connection.organization_id = governed.organization_id
        and connection.id = governed.domo_connection_id
      for share;

      if governed_source_lifecycle is distinct from 'approved'
         or governed_source_status is distinct from 'active'
         or governed_source_fingerprint is null
         or governed.approved_domo_dataset_fingerprint is distinct from governed_source_fingerprint
         or governed_domo_connection_status is distinct from 'ready' then
        raise exception 'Valid Domo observations require the exact currently approved dataset source and a ready Domo connection';
      end if;
    elsif governed.source_method is distinct from 'endpoint_recipe' then
      raise exception 'Valid observations require a governed provider source';
    end if;

    if new.source_fingerprint is distinct from governed.canonical_source_fingerprint then
      raise exception 'Observation source fingerprint does not match the approved binding contract';
    end if;
  end if;

  new.source_fingerprint := governed.canonical_source_fingerprint;
  return new;
end;
$$;
revoke all on function public.bind_observation_identity() from public, anon, authenticated;

-- Atomic evidence + approval for Domo dataset bindings.
create or replace function public.approve_domo_dataset_binding(
  p_organization_id uuid,
  p_source_id uuid,
  p_binding_id uuid,
  p_actor_profile_id uuid,
  p_row_count bigint,
  p_computed_value numeric,
  p_reference_value numeric,
  p_tolerance numeric,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.domo_dataset_sources%rowtype;
  v_binding public.custom_kpi_location_bindings%rowtype;
  v_actor_role text;
  v_delta numeric;
  v_approved boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_request_id is null or pg_catalog.length(pg_catalog.btrim(p_request_id)) < 12
     or pg_catalog.length(p_request_id) > 160 then
    raise exception 'A bounded approval request ID is required' using errcode = '22023';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start
     or p_period_end > v_now + interval '5 minutes' then
    raise exception 'A valid completed sample period is required' using errcode = '22023';
  end if;
  if p_row_count is null or p_row_count < 0
     or not public.is_finite_numeric(p_computed_value)
     or not public.is_finite_numeric(p_reference_value)
     or not public.is_finite_numeric(p_tolerance) or p_tolerance < 0 then
    raise exception 'Finite sample and reconciliation values are required' using errcode = '22023';
  end if;

  select membership.role into v_actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.profile_id = p_actor_profile_id
    and membership.status = 'active'
  for share;
  if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
    raise exception 'An active tenant owner or admin must authorize approval' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.audit_events event
    where event.organization_id = p_organization_id
      and event.action = 'domo.dataset_binding.governance'
      and event.resource_id = p_binding_id
      and event.request_id = p_request_id
  ) then
    raise exception 'This approval request ID has already been used' using errcode = '23505';
  end if;

  select source.* into v_source
  from public.domo_dataset_sources source
  where source.organization_id = p_organization_id and source.id = p_source_id
  for update;
  if v_source.id is null or v_source.status <> 'active' or v_source.lifecycle = 'archived' then
    raise exception 'The exact active Domo dataset source is unavailable' using errcode = 'P0002';
  end if;

  select binding.* into v_binding
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id and binding.id = p_binding_id
  for update;
  if v_binding.id is null or v_binding.approval_status = 'archived'
     or v_binding.source_method <> 'domo_dataset'
     or v_binding.domo_dataset_source_id is distinct from v_source.id
     or v_binding.domo_connection_id is distinct from v_source.domo_connection_id then
    raise exception 'The binding does not match the exact Domo dataset contract' using errcode = '22023';
  end if;

  perform 1 from public.organizations organization
  where organization.id = p_organization_id and organization.status = 'active'
  for share;
  if not found then raise exception 'The tenant organization is not active' using errcode = '42501'; end if;

  perform 1 from public.locations location
  where location.organization_id = p_organization_id and location.id = v_binding.location_id
    and location.status = 'active'
  for share;
  if not found then raise exception 'The exact binding location is not active' using errcode = '42501'; end if;

  perform 1 from public.custom_kpi_definitions definition
  where definition.organization_id = p_organization_id and definition.id = v_binding.kpi_definition_id
    and definition.lifecycle = 'published' and definition.type = 'external'
  for share;
  if not found then raise exception 'The exact external KPI definition is not published' using errcode = '42501'; end if;

  perform 1 from public.domo_connections connection
  where connection.organization_id = p_organization_id and connection.id = v_binding.domo_connection_id
    and connection.status = 'ready'
  for share;
  if not found then raise exception 'The exact Domo connection is not ready' using errcode = '42501'; end if;

  if v_binding.approved_domo_dataset_fingerprint is distinct from v_source.canonical_source_fingerprint then
    raise exception 'The Domo dataset source changed after the binding was drafted; re-save the binding' using errcode = '22023';
  end if;

  v_delta := p_computed_value - p_reference_value;
  v_approved := pg_catalog.abs(v_delta) <= p_tolerance;

  if v_source.lifecycle = 'draft' then
    update public.domo_dataset_sources source
    set lifecycle = 'inspected', inspected_at = v_now, updated_at = v_now
    where source.id = v_source.id;
  end if;

  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    row_count, computed_value, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'sample', v_binding.canonical_source_fingerprint, 'pass',
    p_row_count, p_computed_value, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id, 'method', 'domo_dataset'),
    p_actor_profile_id
  );
  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    expected_value, reference_value, tolerance, delta, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'reconciliation', v_binding.canonical_source_fingerprint,
    case when v_approved then 'pass' else 'fail' end,
    p_computed_value, p_reference_value, p_tolerance, v_delta, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id, 'method', 'domo_dataset'),
    p_actor_profile_id
  );

  if v_approved then
    update public.domo_dataset_sources source
    set lifecycle = 'approved', inspected_at = coalesce(source.inspected_at, v_now),
        approved_at = v_now, approved_by = p_actor_profile_id, updated_at = v_now
    where source.id = v_source.id and source.lifecycle <> 'approved';
    update public.custom_kpi_location_bindings binding
    set approval_status = 'approved', approved_at = v_now, approved_by = p_actor_profile_id,
        updated_at = v_now
    where binding.id = v_binding.id;
  end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, p_actor_profile_id, 'domo.dataset_binding.governance',
    'custom_kpi_location_bindings', v_binding.id,
    pg_catalog.jsonb_build_object('sourceLifecycle', v_source.lifecycle, 'bindingApprovalStatus', v_binding.approval_status),
    pg_catalog.jsonb_build_object('approved', v_approved, 'rowCount', p_row_count, 'delta', v_delta, 'tolerance', p_tolerance),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'approved', v_approved, 'delta', v_delta, 'tolerance', p_tolerance,
    'sourceId', v_source.id, 'bindingId', v_binding.id,
    'sourceFingerprint', v_source.canonical_source_fingerprint,
    'bindingFingerprint', v_binding.canonical_source_fingerprint
  );
end;
$$;
revoke all on function public.approve_domo_dataset_binding(
  uuid, uuid, uuid, uuid, bigint, numeric, numeric, numeric, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.approve_domo_dataset_binding(
  uuid, uuid, uuid, uuid, bigint, numeric, numeric, numeric, timestamptz, timestamptz, text
) to service_role;

-- Scheduling surface for approved Domo bindings.
create or replace function public.get_due_domo_bindings(p_limit integer default 50)
returns table (
  organization_id uuid,
  binding_id uuid,
  domo_connection_id uuid,
  domo_dataset_source_id uuid,
  refresh_interval text,
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

insert into public.schema_releases (release_marker)
values ('20260820002100_domo_dataset_integration');

-- Release readiness gate for the full 019+020+021 rollout.
create or replace function public.get_data_platform_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_catalog.to_regclass('public.service_titan_endpoint_ingestion_runs') is not null
      and pg_catalog.to_regclass('public.service_titan_custom_endpoint_sources') is not null
      and pg_catalog.to_regclass('public.domo_connections') is not null
      and pg_catalog.to_regclass('public.domo_dataset_sources') is not null
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002100_domo_dataset_integration'
      ) as ready,
    '20260820002100_domo_dataset_integration'::text as release_marker;
$$;
revoke all on function public.get_data_platform_release_readiness() from public;
grant execute on function public.get_data_platform_release_readiness() to anon, authenticated, service_role;

commit;
