-- Executive Operator Scorecard: governed MTD/PY comparison contract and source recipes.
-- No provider IDs are seeded here: completed-job-type-count bindings must carry the
-- tenant-approved job type IDs in parameter_values.includedJobTypeIds.

begin;

-- A comparison is an approved binding contract, not a dashboard calculation.  The
-- current MTD period and the same local elapsed MTD period one calendar year earlier
-- are both executed by the trusted worker using the same endpoint recipe and reducer.
alter table public.custom_kpi_location_bindings
  add column comparison_basis text not null default 'none'
  check (comparison_basis in ('none', 'prior_year_to_date'));
alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_comparison_contract_check check (
    comparison_basis = 'none'
    or (source_method = 'endpoint_recipe' and observation_window = 'mtd')
  );

alter table public.kpi_observations
  add column comparison_basis text not null default 'none'
  check (comparison_basis in ('none', 'prior_year_to_date')),
  add column comparison_value numeric,
  add column comparison_numerator numeric,
  add column comparison_denominator numeric,
  add column comparison_period_start timestamptz,
  add column comparison_period_end timestamptz;
alter table public.kpi_observations
  add constraint kpi_observations_comparison_shape check (
    (comparison_basis = 'none'
      and comparison_value is null and comparison_numerator is null and comparison_denominator is null
      and comparison_period_start is null and comparison_period_end is null)
    or
    (comparison_basis = 'prior_year_to_date'
      and public.is_finite_numeric(comparison_value)
      and (comparison_numerator is null or public.is_finite_numeric(comparison_numerator))
      and (comparison_denominator is null or public.is_finite_numeric(comparison_denominator))
      and comparison_period_start is not null and comparison_period_end is not null
      and comparison_period_end > comparison_period_start)
  );

-- Canonical fingerprints keep legacy/non-comparison bindings byte-for-byte stable.
-- Comparison bindings derive a new canonical identity from the complete existing
-- governed identity plus their comparison basis before evidence can be approved.
create or replace function public.validate_kpi_binding_comparison_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.comparison_basis = 'prior_year_to_date'
     and (new.source_method <> 'endpoint_recipe' or new.observation_window <> 'mtd') then
    raise exception 'Prior-year comparison requires an endpoint-recipe MTD binding';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_kpi_binding_comparison_contract() from public, anon, authenticated;

drop trigger if exists custom_kpi_bindings_05_validate_comparison_contract on public.custom_kpi_location_bindings;
create trigger custom_kpi_bindings_05_validate_comparison_contract
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.validate_kpi_binding_comparison_contract();

create or replace function public.fingerprint_kpi_binding_comparison_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.comparison_basis = 'prior_year_to_date' and new.canonical_source_fingerprint is not null then
    new.canonical_source_fingerprint := public.canonical_source_fingerprint(
      pg_catalog.jsonb_build_object(
        'bindingFingerprint', new.canonical_source_fingerprint,
        'comparisonBasis', new.comparison_basis
      )
    );
  end if;
  return new;
end;
$$;
revoke all on function public.fingerprint_kpi_binding_comparison_contract() from public, anon, authenticated;

drop trigger if exists custom_kpi_bindings_15_fingerprint_comparison_contract on public.custom_kpi_location_bindings;
create trigger custom_kpi_bindings_15_fingerprint_comparison_contract
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.fingerprint_kpi_binding_comparison_contract();

create or replace function public.validate_kpi_observation_comparison_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comparison_basis text;
begin
  select binding.comparison_basis into v_comparison_basis
  from public.custom_kpi_location_bindings binding
  where binding.id = new.binding_id and binding.organization_id = new.organization_id
  for share;
  if v_comparison_basis is null then
    raise exception 'Observation requires an exact KPI location binding';
  end if;
  if new.comparison_basis is distinct from v_comparison_basis then
    raise exception 'Observation comparison basis does not match its binding contract';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_kpi_observation_comparison_contract() from public, anon, authenticated;

drop trigger if exists kpi_observations_05_validate_comparison_contract on public.kpi_observations;
create trigger kpi_observations_05_validate_comparison_contract
before insert on public.kpi_observations
for each row execute function public.validate_kpi_observation_comparison_contract();

-- Catalog defaults carry the governed comparison intent into the published KPI
-- definition metadata. Existing catalog rows retain no comparison by default.
alter table public.original_kpi_catalog
  add column default_comparison_basis text not null default 'none'
  check (default_comparison_basis in ('none', 'prior_year_to_date'));

-- New executive catalog KPI bindings are pinned to their migration-owned recipe and
-- comparison contract. The browser cannot weaken this contract; draft generation
-- and manual Admin configuration receive the catalog comparison basis server-side.
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
    and catalog.kpi_key in ('repair-job-volume', 'maintenance-job-volume', 'sales-opportunity-volume', 'sales-average-ticket');

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
drop trigger if exists custom_kpi_bindings_04_enforce_executive_catalog_contract on public.custom_kpi_location_bindings;
create trigger custom_kpi_bindings_04_enforce_executive_catalog_contract
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.enforce_executive_catalog_binding_contract();

-- New recipe cadence contracts. The worker owns provider endpoint/reducer semantics;
-- this allowlist remains the database authority for selectable approved bindings.
insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval, selectable_for_new_bindings)
values
  ('completed-job-type-count', 2, '30m', true),
  ('completed-job-type-count', 2, '1h', true),
  ('completed-job-type-count', 2, '4h', true),
  ('completed-job-type-count', 2, '24h', true),
  ('sales-opportunity-count', 1, '30m', true),
  ('sales-opportunity-count', 1, '1h', true),
  ('sales-opportunity-count', 1, '4h', true),
  ('sales-opportunity-count', 1, '24h', true),
  ('sold-estimate-average-ticket', 1, '30m', true),
  ('sold-estimate-average-ticket', 1, '1h', true),
  ('sold-estimate-average-ticket', 1, '4h', true),
  ('sold-estimate-average-ticket', 1, '24h', true)
on conflict do nothing;

-- The scorecard adds tenant-enableable catalog KPI definitions. Job-type IDs are
-- deliberately binding parameters rather than migration seed data, so no guessed
-- repair, maintenance, or club classification can enter production contracts.
insert into public.original_kpi_catalog (
  kpi_key, catalog_version, title, section, value_kind, direction, subtitle,
  source_system, source_readiness_requirement, endpoint_recipe_id, endpoint_recipe_version,
  default_refresh_cadence, default_stale_after_hours, default_warning_attainment,
  default_critical_attainment, playbook, presentation, default_observation_window, default_comparison_basis
) values
  ('repair-job-volume', 1, 'Repair Job Volume', 'executive', 'number', 'higher',
   'Completed repair jobs in the month-to-date period versus the same local elapsed period last year.',
   'ServiceTitan', 'service_titan_connection', 'completed-job-type-count', 2, '1h', 4, 100, 90, '[]', '{}', 'mtd', 'prior_year_to_date'),
  ('maintenance-job-volume', 1, 'Maintenance Job Volume', 'executive', 'number', 'higher',
   'Completed maintenance jobs in the month-to-date period versus the same local elapsed period last year.',
   'ServiceTitan', 'service_titan_connection', 'completed-job-type-count', 2, '1h', 4, 100, 90, '[]', '{}', 'mtd', 'prior_year_to_date'),
  ('sales-opportunity-volume', 1, 'Sales Opportunity Volume', 'executive', 'number', 'higher',
   'Distinct estimate job opportunities created in the month-to-date period versus the same local elapsed period last year.',
   'ServiceTitan', 'service_titan_connection', 'sales-opportunity-count', 1, '1h', 4, 100, 90, '[]', '{}', 'mtd', 'prior_year_to_date'),
  ('sales-average-ticket', 1, 'Sales Average Ticket', 'executive', 'currency', 'higher',
   'Sold estimate subtotal divided by sold estimate record count in the month-to-date period versus the same local elapsed period last year.',
   'ServiceTitan', 'service_titan_connection', 'sold-estimate-average-ticket', 1, '1h', 4, 100, 90, '[]', '{}', 'mtd', 'prior_year_to_date')
on conflict (kpi_key, catalog_version) do nothing;

-- Existing avg-ticket remains available for historical lineage. It is not retired by
-- this release: retirement requires a successor binding to pass governed evidence and
-- approval for the tenant, which a static migration cannot truthfully assert.

do $$
begin
  if (select count(*) from public.original_kpi_catalog where catalog_version = 1 and kpi_key in (
    'repair-job-volume', 'maintenance-job-volume', 'sales-opportunity-volume', 'sales-average-ticket'
  )) <> 4 then
    raise exception 'Executive Operator Scorecard catalog contract is incomplete';
  end if;
  if (select count(*) from public.service_titan_endpoint_recipe_refresh_policies
      where (endpoint_recipe_id, endpoint_recipe_version) in (
        ('completed-job-type-count', 2), ('sales-opportunity-count', 1), ('sold-estimate-average-ticket', 1)
      ) and selectable_for_new_bindings and refresh_interval in ('30m', '1h', '4h', '24h')) <> 12 then
    raise exception 'Executive Operator Scorecard endpoint refresh policy contract is incomplete';
  end if;
end;
$$;

-- The endpoint worker needs the immutable parameter contract (job-type IDs) and
-- comparison basis alongside the existing window/timezone scheduling fields.
drop function if exists public.get_due_endpoint_bindings(integer);
create function public.get_due_endpoint_bindings(p_limit integer default 50)
returns table (
  organization_id uuid, binding_id uuid, connection_id uuid, service_titan_tenant_id text,
  endpoint_recipe_id text, endpoint_recipe_version integer, refresh_interval text,
  observation_window text, comparison_basis text, location_timezone text,
  parameter_values jsonb, business_unit_mappings jsonb, location_id uuid,
  kpi_definition_id uuid, canonical_source_fingerprint text, last_period_end timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    binding.organization_id, binding.id, binding.connection_id, binding.service_titan_tenant_id,
    binding.endpoint_recipe_id, binding.endpoint_recipe_version, binding.refresh_interval,
    binding.observation_window, binding.comparison_basis, location.timezone,
    binding.parameter_values, binding.business_unit_mappings, binding.location_id,
    binding.kpi_definition_id, binding.canonical_source_fingerprint,
    (
      select pg_catalog.max(observation.period_end)
      from public.kpi_observations observation
      where observation.organization_id = binding.organization_id
        and observation.binding_id = binding.id and observation.status = 'valid'
        and observation.source_fingerprint = binding.canonical_source_fingerprint
    ) as last_period_end
  from public.custom_kpi_location_bindings binding
  join public.organizations organization
    on organization.id = binding.organization_id and organization.status = 'active'
  join public.custom_kpi_definitions definition
    on definition.organization_id = binding.organization_id and definition.id = binding.kpi_definition_id
   and definition.lifecycle = 'published'
  join public.locations location
    on location.organization_id = binding.organization_id and location.id = binding.location_id
   and location.status = 'active'
  join public.service_titan_connections connection
    on connection.organization_id = binding.organization_id and connection.id = binding.connection_id
   and connection.service_titan_tenant_id = binding.service_titan_tenant_id and connection.status = 'ready'
  join public.service_titan_connection_locations assignment
    on assignment.organization_id = binding.organization_id and assignment.connection_id = binding.connection_id
   and assignment.location_id = binding.location_id and assignment.revoked_at is null
  where binding.source_method = 'endpoint_recipe' and binding.approval_status = 'approved'
    and coalesce((
      select pg_catalog.max(observation.period_end) from public.kpi_observations observation
      where observation.organization_id = binding.organization_id and observation.binding_id = binding.id
        and observation.status = 'valid' and observation.source_fingerprint = binding.canonical_source_fingerprint
    ), 'epoch'::timestamptz) <= pg_catalog.now() - case binding.refresh_interval
      when '15m' then interval '15 minutes' when '30m' then interval '30 minutes'
      when '1h' then interval '1 hour' when '4h' then interval '4 hours'
      when '12h' then interval '12 hours' else interval '24 hours' end
  order by last_period_end nulls first
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.get_due_endpoint_bindings(integer) from public, anon, authenticated;
grant execute on function public.get_due_endpoint_bindings(integer) to service_role;
comment on function public.get_due_endpoint_bindings(integer) is
  'Service-role scheduling surface for approved endpoint bindings, including the immutable parameter and MTD/PY comparison contracts.';

-- Catalog extensions must not make earlier readiness probes report false merely
-- because additional governed endpoint KPI contracts now exist.
-- Preserve legacy readiness gates as the governed KPI catalog expands beyond the
-- original 36 rows.
create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql stable security definer set search_path = ''
as $$
  select
    exists (select 1 from public.schema_releases where release_marker = '20260819001600_enterprise_admin_hardening')
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) >= 36
      and exists (select 1 from public.portfolios where id = 'c1000000-0000-4000-8000-000000000001' and slug = 'champions-group' and status = 'active')
      and exists (select 1 from public.portfolio_memberships where portfolio_id = 'c1000000-0000-4000-8000-000000000001' and role = 'owner' and status = 'active')
      and not exists (
        select 1 from public.organizations organization
        where organization.status = 'active' and not exists (
          select 1 from public.portfolio_organizations attachment
          where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
            and attachment.organization_id = organization.id and attachment.status = 'active'
        )
      ) as ready,
    '20260819001600_enterprise_admin_hardening'::text as release_marker;
$$;
revoke all on function public.get_release_readiness() from public;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;

create or replace function public.get_division_release_readiness()
returns table (ready boolean, release_marker text)
language sql stable security definer set search_path = ''
as $$
  select
    exists (select 1 from public.schema_releases where release_marker = '20260819001700_tenant_managed_divisions')
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) >= 36
      and not exists (select 1 from public.organization_divisions where pg_catalog.lower(name) in ('not mapped', 'unmapped'))
      and exists (select 1 from public.portfolios where id = 'c1000000-0000-4000-8000-000000000001' and slug = 'champions-group' and status = 'active')
      and exists (select 1 from public.portfolio_memberships where portfolio_id = 'c1000000-0000-4000-8000-000000000001' and role = 'owner' and status = 'active')
      and not exists (
        select 1 from public.organizations organization
        where organization.status = 'active' and not exists (
          select 1 from public.portfolio_organizations attachment
          where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
            and attachment.organization_id = organization.id and attachment.status = 'active'
        )
      ) as ready,
    '20260819001700_tenant_managed_divisions'::text as release_marker;
$$;
revoke all on function public.get_division_release_readiness() from public;
grant execute on function public.get_division_release_readiness() to anon, authenticated, service_role;

create or replace function public.get_region_release_readiness()
returns table (ready boolean, release_marker text)
language sql stable security definer set search_path = ''
as $$
  select
    exists (select 1 from public.schema_releases where release_marker = '20260819001800_location_regions')
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) >= 36
      and not exists (select 1 from public.organization_divisions where pg_catalog.lower(name) in ('not mapped', 'unmapped'))
      and not exists (select 1 from public.locations where region is not null and region not in ('west', 'midwest', 'northwest', 'southwest'))
      and exists (select 1 from public.portfolios where id = 'c1000000-0000-4000-8000-000000000001' and slug = 'champions-group' and status = 'active')
      and exists (select 1 from public.portfolio_memberships where portfolio_id = 'c1000000-0000-4000-8000-000000000001' and role = 'owner' and status = 'active')
      and not exists (
        select 1 from public.organizations organization
        where organization.status = 'active' and not exists (
          select 1 from public.portfolio_organizations attachment
          where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
            and attachment.organization_id = organization.id and attachment.status = 'active'
        )
      ) as ready,
    '20260819001800_location_regions'::text as release_marker;
$$;
revoke all on function public.get_region_release_readiness() from public;
grant execute on function public.get_region_release_readiness() to anon, authenticated, service_role;

create or replace function public.get_tranche1_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select pg_catalog.count(*) from public.original_kpi_catalog
     where catalog_version = 1 and endpoint_recipe_id is not null) >= 23
      and exists (
        select 1 from public.original_kpi_catalog
        where catalog_version = 1 and kpi_key = 'booking-rate'
          and endpoint_recipe_id = 'inbound-call-booking-rate' and endpoint_recipe_version = 3
      )
      and exists (
        select 1 from public.original_kpi_catalog
        where catalog_version = 1 and kpi_key = 'ytd-revenue'
          and default_observation_window = 'ytd'
      )
      and exists (
        select 1 from public.service_titan_endpoint_recipe_refresh_policies
        where endpoint_recipe_id = 'membership-net-growth' and endpoint_recipe_version = 2
          and selectable_for_new_bindings
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260822000200_membership_event_recipes_v2'
      ) as ready,
    '20260822000200_membership_event_recipes_v2'::text as release_marker;
$$;
revoke all on function public.get_tranche1_release_readiness() from public;
grant execute on function public.get_tranche1_release_readiness() to anon, authenticated, service_role;

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
           where catalog_version = 1 and default_observation_window = 'mtd') >= 10
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and default_observation_window = 'today') >= 4
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

insert into public.schema_releases (release_marker)
values ('20260827000100_executive_operator_scorecard_recipes');

commit;
