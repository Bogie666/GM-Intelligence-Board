begin;

-- Retain v1 rows for historical ingestion/lineage, but block new selection and approval.
update public.service_titan_endpoint_recipe_refresh_policies
set selectable_for_new_bindings = false
where endpoint_recipe_id = 'sold-estimates-value'
  and endpoint_recipe_version = 1;

-- Register the exact governed cadence rows used by endpoint-recipe approval and
-- scheduling.  The policy primary key is one row per recipe/version/cadence.
insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval, selectable_for_new_bindings)
values
  ('sold-estimates-value', 2, '30m', true),
  ('sold-estimates-value', 2, '1h', true),
  ('sold-estimates-value', 2, '4h', true),
  ('sold-estimates-value', 2, '24h', true)
on conflict (endpoint_recipe_id, endpoint_recipe_version, refresh_interval) do update
set selectable_for_new_bindings = excluded.selectable_for_new_bindings;

-- New catalog enablement uses v2.  Catalog version 1 remains the stable catalog
-- identity; definition versions are tenant history and may advance independently.
update public.original_kpi_catalog
set
  title = 'Committed Pipeline',
  subtitle = 'Sold estimate value on active fulfillment work scheduled to complete by local period-end',
  source_system = 'ServiceTitan',
  source_readiness_requirement = 'service_titan_business_unit_mapping',
  endpoint_recipe_id = 'sold-estimates-value',
  endpoint_recipe_version = 2,
  default_refresh_cadence = '1h',
  default_stale_after_hours = 24,
  default_observation_window = 'mtd',
  default_comparison_basis = 'none',
  presentation = presentation || pg_catalog.jsonb_build_object(
    'observationWindow', 'mtd',
    'comparisonBasis', 'none',
    'requiresBusinessUnitMapping', true,
    'grain', 'canonical_sold_estimate_scope'
  )
where kpi_key = 'pipeline' and catalog_version = 1;

-- A migration-owned publication still needs the same provenance as a service-role
-- publication.  Fail the transaction rather than silently archive a tenant's only
-- published definition when no active same-organization owner/admin can approve its
-- successor.
do $$
begin
  if exists (
    select 1
    from public.custom_kpi_definitions definition
    where definition.kpi_key = 'pipeline'
      and definition.lifecycle = 'published'
      and (
        definition.external_source ->> 'endpointRecipeId' is distinct from 'sold-estimates-value'
        or definition.external_source ->> 'endpointRecipeVersion' is distinct from '2'
      )
      and not exists (
        select 1
        from public.organization_memberships membership
        join public.organizations organization on organization.id = membership.organization_id
        where membership.organization_id = definition.organization_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin')
          and organization.status = 'active'
      )
  ) then
    raise exception 'Scheduled pipeline v2 publication requires an active same-organization owner/admin attribution';
  end if;
end;
$$;

-- Published definitions are immutable. Archive only the legacy published version and
-- append the next tenant definition version. Existing bindings and observations keep
-- their old definition foreign key; this migration deliberately creates no binding.
with publication_candidates as (
  select
    definition.id,
    definition.organization_id,
    definition.kpi_key,
    definition.section,
    definition.value_kind,
    definition.direction,
    definition.scope_mode,
    definition.viewer_roles,
    definition.external_source,
    governor.profile_id as approved_by,
    (
      select coalesce(pg_catalog.max(existing.version), 0) + 1
      from public.custom_kpi_definitions existing
      where existing.organization_id = definition.organization_id
        and existing.kpi_key = definition.kpi_key
    ) as next_version
  from public.custom_kpi_definitions definition
  cross join lateral (
    select membership.profile_id
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.organization_id = definition.organization_id
      and membership.status = 'active'
      and membership.role in ('owner', 'admin')
      and organization.status = 'active'
    order by case membership.role when 'owner' then 0 else 1 end,
             membership.joined_at nulls last,
             membership.profile_id
    limit 1
  ) governor
  where definition.kpi_key = 'pipeline'
    and definition.lifecycle = 'published'
    and (
      definition.external_source ->> 'endpointRecipeId' is distinct from 'sold-estimates-value'
      or definition.external_source ->> 'endpointRecipeVersion' is distinct from '2'
    )
), archived as (
  update public.custom_kpi_definitions definition
  set lifecycle = 'archived', updated_at = pg_catalog.clock_timestamp()
  from publication_candidates candidate
  where definition.id = candidate.id
  returning candidate.*
)
insert into public.custom_kpi_definitions (
  organization_id, kpi_key, version, type, lifecycle, title, business_definition,
  owner_profile_id, section, value_kind, direction, subtitle, scope_mode, viewer_roles,
  formula, external_source, refresh_cadence, stale_after_hours, release_note,
  validation_results, validated_at, published_at, approved_by
)
select
  organization_id, kpi_key, next_version, 'service_titan', 'published',
  'Committed Pipeline',
  'Canonical sold estimate subtotal counted once for active fulfillment work whose final scheduled appointment ends after the observation timestamp and by local month-end.',
  approved_by, section, value_kind, direction,
  'Sold work scheduled to complete by local period-end',
  scope_mode, viewer_roles, '{}'::jsonb,
  (external_source - 'endpointRecipeId' - 'endpointRecipeVersion' - 'sourceSystem' - 'sourceReadinessRequirement')
    || pg_catalog.jsonb_build_object(
      'sourceSystem', 'ServiceTitan',
      'sourceReadinessRequirement', 'service_titan_business_unit_mapping',
      'endpointRecipeId', 'sold-estimates-value',
      'endpointRecipeVersion', 2,
      'observationWindow', 'mtd',
      'comparisonBasis', 'none',
      'requiresBusinessUnitMapping', true
    ),
  '1h', 24,
  'Scheduled sold pipeline v2 · canonical estimate scope, exact appointment join, required BU mapping',
  '[{"status":"pass","check":"migration-owned sold-estimates-value@2 contract"}]'::jsonb,
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), approved_by
from archived;

-- Database-level fail-closed contract. Scope this guard to the exact recipe ID AND
-- version so historical v1 and unrelated version-2 recipes retain their own contracts.
alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_scheduled_pipeline_v2_contract check (
    case
      when source_method = 'endpoint_recipe'
        and endpoint_recipe_id = 'sold-estimates-value'
        and endpoint_recipe_version = 2
      then approval_status <> 'approved'
        or (observation_window = 'mtd'
        and comparison_basis = 'none'
        and parameter_values = '{}'::jsonb
        and business_unit_mappings - 'includedBusinessUnitIds' = '{}'::jsonb
        and case
          when pg_catalog.jsonb_typeof(business_unit_mappings -> 'includedBusinessUnitIds') = 'array'
          then pg_catalog.jsonb_array_length(business_unit_mappings -> 'includedBusinessUnitIds') between 1 and 500
          else false
        end)
      else true
    end
  );

-- Pin the governed pipeline definition to its exact recipe and MTD window. A
-- recipe-specific CHECK alone cannot prevent a pipeline definition from being
-- drafted against an unrelated endpoint recipe.
create or replace function public.enforce_executive_catalog_binding_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_recipe_id text;
  expected_recipe_version integer;
  expected_window text;
  expected_comparison text;
begin
  select catalog.endpoint_recipe_id, catalog.endpoint_recipe_version,
         catalog.default_observation_window, catalog.default_comparison_basis
    into expected_recipe_id, expected_recipe_version, expected_window, expected_comparison
  from public.custom_kpi_definitions definition
  join public.original_kpi_catalog catalog
    on catalog.kpi_key = definition.kpi_key and catalog.catalog_version = 1
  where definition.organization_id = new.organization_id
    and definition.id = new.kpi_definition_id
    and catalog.kpi_key in (
      'pipeline', 'repair-job-volume', 'maintenance-job-volume',
      'sales-opportunity-volume', 'sales-average-ticket'
    );

  if expected_recipe_id is null then return new; end if;
  if new.source_method <> 'endpoint_recipe'
     or new.endpoint_recipe_id <> expected_recipe_id
     or new.endpoint_recipe_version <> expected_recipe_version
     or new.observation_window <> expected_window then
    raise exception 'Executive catalog binding must use its exact migration-approved endpoint recipe and observation window';
  end if;
  new.comparison_basis := expected_comparison;
  return new;
end;
$$;
revoke all on function public.enforce_executive_catalog_binding_contract() from public, anon, authenticated;

-- Archived catalog history and tenant definition versions are separate from catalog
-- versioning. Only a live conflicting row blocks enablement; archived rows cause a new
-- next definition version, and an already-live original-catalog row is idempotent.
create or replace function public.enable_original_kpi_catalog(
  p_organization_id uuid,
  p_kpi_keys text[]
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
  if p_kpi_keys is null or pg_catalog.array_position(p_kpi_keys, null) is not null then
    raise exception 'KPI key selection must be a non-null text array' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(p_kpi_keys) selected_key
    where not exists (
      select 1 from public.original_kpi_catalog catalog
      where catalog.catalog_version = 1 and catalog.kpi_key = selected_key
    )
  ) then
    raise exception 'KPI key selection contains an unknown original catalog key' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.custom_kpi_definitions existing
    join public.original_kpi_catalog catalog
      on catalog.catalog_version = 1 and catalog.kpi_key = existing.kpi_key
    where existing.organization_id = p_organization_id
      and existing.lifecycle <> 'archived'
      and (pg_catalog.cardinality(p_kpi_keys) = 0 or existing.kpi_key = any (p_kpi_keys))
      and (
        existing.lifecycle is distinct from 'published'
        or existing.title is distinct from catalog.title
        or existing.section is distinct from catalog.section
        or existing.value_kind is distinct from catalog.value_kind
        or existing.direction is distinct from catalog.direction
        or existing.external_source ->> 'catalogName' is distinct from 'original'
        or existing.external_source ->> 'catalogVersion' is distinct from catalog.catalog_version::text
      )
  ) then
    raise exception 'an existing KPI key conflicts with the original catalog; resolve it before enablement'
      using errcode = '23505';
  end if;

  insert into public.custom_kpi_definitions (
    organization_id, kpi_key, version, type, lifecycle, title, business_definition,
    owner_profile_id, section, value_kind, direction, subtitle, scope_mode, viewer_roles,
    formula, external_source, refresh_cadence, stale_after_hours, release_note,
    validation_results, validated_at, published_at
  )
  select
    p_organization_id, catalog.kpi_key,
    (
      select coalesce(pg_catalog.max(history.version), 0) + 1
      from public.custom_kpi_definitions history
      where history.organization_id = p_organization_id and history.kpi_key = catalog.kpi_key
    ),
    case catalog.source_system
      when 'ServiceTitan' then 'service_titan'
      when 'Derived' then 'derived'
      when 'Budget' then 'manual'
      else 'external'
    end,
    'published', catalog.title,
    catalog.title || ': ' || catalog.subtitle,
    auth.uid(), catalog.section, catalog.value_kind, catalog.direction, catalog.subtitle,
    'selected_locations',
    '["owner","admin","brand_executive","general_manager","department_leader","viewer"]'::jsonb,
    case when catalog.source_system = 'Derived'
      then pg_catalog.jsonb_build_object('catalogManaged', true) else '{}'::jsonb end,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'catalogName', 'original', 'catalogVersion', catalog.catalog_version,
      'sourceSystem', catalog.source_system,
      'sourceReadinessRequirement', catalog.source_readiness_requirement,
      'endpointRecipeId', catalog.endpoint_recipe_id,
      'endpointRecipeVersion', catalog.endpoint_recipe_version,
      'observationWindow', catalog.default_observation_window,
      'comparisonBasis', catalog.default_comparison_basis,
      'defaultWarningAttainment', catalog.default_warning_attainment,
      'defaultCriticalAttainment', catalog.default_critical_attainment,
      'playbook', catalog.playbook, 'presentation', catalog.presentation
    )),
    catalog.default_refresh_cadence, catalog.default_stale_after_hours,
    'Original KPI catalog v1 · 20260819001500_servicetitan_discovery_kpi_catalog',
    '[{"status":"pass","check":"migration-owned original KPI catalog v1"}]'::jsonb,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  from public.original_kpi_catalog catalog
  where catalog.catalog_version = 1
    and (pg_catalog.cardinality(p_kpi_keys) = 0 or catalog.kpi_key = any (p_kpi_keys))
    and not exists (
      select 1 from public.custom_kpi_definitions existing
      where existing.organization_id = p_organization_id
        and existing.kpi_key = catalog.kpi_key
        and existing.lifecycle <> 'archived'
    )
  order by catalog.section, catalog.kpi_key
  on conflict (organization_id, kpi_key, version) do nothing;
  get diagnostics inserted_count = row_count;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'original_kpi_catalog.enable',
    'custom_kpi_definitions', null, null,
    pg_catalog.jsonb_build_object('catalogVersion', 1, 'insertedCount', inserted_count,
      'requestedAll', pg_catalog.cardinality(p_kpi_keys) = 0),
    pg_catalog.current_setting('request.id', true)
  );
  return inserted_count;
end;
$$;

comment on function public.enable_original_kpi_catalog(uuid, text[]) is
  'Idempotently publishes original-catalog definitions: archived tenant history is preserved, live catalog definitions are skipped, and a new publication uses the next tenant definition version.';

insert into public.schema_releases (release_marker)
values ('20260828000100_scheduled_sold_pipeline_v2');

-- Migration smoke checks fail the transaction if schema/catalog registration drifted.
do $$
begin
  if (
    select pg_catalog.count(*)
    from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'sold-estimates-value'
      and endpoint_recipe_version = 2
      and refresh_interval in ('30m', '1h', '4h', '24h')
      and selectable_for_new_bindings
  ) <> 4 or exists (
    select 1
    from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'sold-estimates-value'
      and endpoint_recipe_version = 2
      and refresh_interval not in ('30m', '1h', '4h', '24h')
  ) then
    raise exception 'sold-estimates-value@2 refresh policy registration failed';
  end if;
  if not exists (
    select 1 from public.original_kpi_catalog
    where kpi_key = 'pipeline' and catalog_version = 1
      and source_system = 'ServiceTitan'
      and source_readiness_requirement = 'service_titan_business_unit_mapping'
      and endpoint_recipe_id = 'sold-estimates-value' and endpoint_recipe_version = 2
      and default_refresh_cadence = '1h'
      and default_observation_window = 'mtd'
      and default_comparison_basis = 'none'
  ) then
    raise exception 'pipeline catalog registration failed';
  end if;
end;
$$;

commit;
