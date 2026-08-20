begin;

-- ---------------------------------------------------------------------------
-- Catalog recipe expansion + governed auto-binding
--
-- 1. Wires nine additional original-catalog KPIs to governed endpoint recipes
--    (department revenue and close rates reuse the proven completed-revenue and
--    sales-close-rate contracts with business-unit scoping; average ticket and
--    call booking counts get new versioned recipe contracts implemented in the
--    trusted worker).
-- 2. Registers refresh policies for the four new recipes.
-- 3. Adds generate_catalog_recipe_bindings: an authenticated admin RPC that
--    creates DRAFT endpoint-recipe bindings for every published catalog KPI
--    with a wired recipe, across every active location assigned to a ready
--    connection. Drafts still require trusted operator approval before any
--    ingestion happens — separation of duties is preserved.
-- ---------------------------------------------------------------------------

-- New recipe refresh policies.
insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
values
  ('completed-jobs-count', 1, '15m'),
  ('completed-jobs-count', 1, '30m'),
  ('completed-jobs-count', 1, '1h'),
  ('completed-jobs-count', 1, '4h'),
  ('completed-jobs-count', 1, '24h'),
  ('average-invoice-ticket', 1, '30m'),
  ('average-invoice-ticket', 1, '1h'),
  ('average-invoice-ticket', 1, '4h'),
  ('average-invoice-ticket', 1, '24h'),
  ('inbound-calls-booked', 1, '15m'),
  ('inbound-calls-booked', 1, '30m'),
  ('inbound-calls-booked', 1, '1h'),
  ('inbound-calls-booked', 1, '4h'),
  ('inbound-calls-not-booked', 1, '15m'),
  ('inbound-calls-not-booked', 1, '30m'),
  ('inbound-calls-not-booked', 1, '1h'),
  ('inbound-calls-not-booked', 1, '4h')
on conflict do nothing;

-- Wire catalog KPIs to recipes. Only semantically exact matches are wired;
-- KPIs whose period basis or source differs (YTD, GA4, budget, derived) stay
-- unwired and use the custom-endpoint / saved-report / Domo paths.
update public.original_kpi_catalog
set endpoint_recipe_id = wiring.recipe_id,
    endpoint_recipe_version = 1
from (
  values
    ('hvac-revenue', 'completed-revenue'),
    ('plumbing-revenue', 'completed-revenue'),
    ('electrical-revenue', 'completed-revenue'),
    ('hvac-close', 'sales-close-rate'),
    ('plumbing-close', 'sales-close-rate'),
    ('hvac-maintenance-close', 'sales-close-rate'),
    ('avg-ticket', 'average-invoice-ticket'),
    ('hvac-ticket', 'average-invoice-ticket'),
    ('calls-booked', 'inbound-calls-booked'),
    ('calls-not-booked', 'inbound-calls-not-booked')
) as wiring(kpi_key, recipe_id)
where original_kpi_catalog.catalog_version = 1
  and original_kpi_catalog.kpi_key = wiring.kpi_key
  and original_kpi_catalog.endpoint_recipe_id is null;

-- ---------------------------------------------------------------------------
-- Draft auto-binding RPC
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
  -- (active location assigned to a ready connection). Existing bindings for
  -- the same KPI + location pair are never touched.
  insert into public.custom_kpi_location_bindings (
    organization_id, kpi_definition_id, location_id, connection_id,
    service_titan_tenant_id, source_method, endpoint_recipe_id,
    endpoint_recipe_version, refresh_interval, approval_status
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
  'Tenant admin RPC: creates draft endpoint-recipe bindings for every published original-catalog KPI with a wired recipe, across active locations assigned to ready connections. Drafts still require trusted operator approval before ingestion.';

insert into public.schema_releases (release_marker)
values ('20260820002400_catalog_recipe_bindings');

create or replace function public.get_catalog_binding_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_catalog.to_regprocedure('public.generate_catalog_recipe_bindings(uuid)') is not null
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and endpoint_recipe_id is not null) >= 15
      and exists (
        select 1 from public.service_titan_endpoint_recipe_refresh_policies policy
        where policy.endpoint_recipe_id = 'average-invoice-ticket' and policy.endpoint_recipe_version = 1
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002400_catalog_recipe_bindings'
      ) as ready,
    '20260820002400_catalog_recipe_bindings'::text as release_marker;
$$;
revoke all on function public.get_catalog_binding_release_readiness() from public;
grant execute on function public.get_catalog_binding_release_readiness() to anon, authenticated, service_role;

commit;
