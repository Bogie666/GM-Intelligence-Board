begin;

-- The endpoint-recipe cadence catalog is release-owned global configuration.
-- Authenticated members may inspect its non-secret cadence metadata; all direct
-- writes remain reserved for forward-only releases.
drop policy if exists endpoint_recipe_refresh_authenticated_read
  on public.service_titan_endpoint_recipe_refresh_policies;
revoke all on table public.service_titan_endpoint_recipe_refresh_policies from anon, authenticated;
grant select on table public.service_titan_endpoint_recipe_refresh_policies to authenticated;
create policy endpoint_recipe_refresh_authenticated_read
  on public.service_titan_endpoint_recipe_refresh_policies
  for select to authenticated
  using (true);

-- Report and binding approval is a separation-of-duties operation. The trusted
-- operator must run a live sample and provide an independently reconciled value.
-- This function is the only write surface needed by that worker: it locks the exact
-- tenant/source/binding contract, appends immutable evidence, and approves atomically.
create or replace function public.record_and_approve_service_titan_saved_report(
  p_organization_id uuid,
  p_report_source_id uuid,
  p_binding_id uuid,
  p_actor_profile_id uuid,
  p_row_count bigint,
  p_computed_value numeric,
  p_reference_value numeric,
  p_tolerance numeric,
  p_observed_schema_fingerprint text,
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
  v_source public.service_titan_report_sources%rowtype;
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
      and event.action = 'servicetitan.saved_report.governance'
      and event.resource_id = p_binding_id
      and event.request_id = p_request_id
  ) then
    raise exception 'This approval request ID has already been used' using errcode = '23505';
  end if;

  select source.* into v_source
  from public.service_titan_report_sources source
  where source.organization_id = p_organization_id and source.id = p_report_source_id
  for update;
  if v_source.id is null or v_source.status <> 'active' or v_source.lifecycle = 'archived' then
    raise exception 'The exact active saved-report source is unavailable' using errcode = 'P0002';
  end if;

  select binding.* into v_binding
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id and binding.id = p_binding_id
  for update;
  if v_binding.id is null or v_binding.approval_status = 'archived'
     or v_binding.source_method <> 'saved_report'
     or v_binding.report_source_id is distinct from v_source.id
     or v_binding.connection_id is distinct from v_source.connection_id
     or v_binding.service_titan_tenant_id is distinct from v_source.service_titan_tenant_id then
    raise exception 'The binding does not match the exact saved-report contract' using errcode = '22023';
  end if;

  -- Lock and revalidate every mutable row in the operational authorization chain.
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
    and definition.lifecycle = 'published' and definition.type = 'service_titan'
  for share;
  if not found then raise exception 'The exact ServiceTitan KPI definition is not published' using errcode = '42501'; end if;

  perform 1 from public.service_titan_connections connection
  where connection.organization_id = p_organization_id and connection.id = v_binding.connection_id
    and connection.service_titan_tenant_id = v_binding.service_titan_tenant_id
    and connection.status = 'ready'
  for share;
  if not found then raise exception 'The exact ServiceTitan connection is not ready' using errcode = '42501'; end if;

  perform 1 from public.service_titan_connection_locations assignment
  where assignment.organization_id = p_organization_id
    and assignment.connection_id = v_binding.connection_id
    and assignment.location_id = v_binding.location_id and assignment.revoked_at is null
  for share;
  if not found then raise exception 'The exact connection-to-location assignment is not active' using errcode = '42501'; end if;

  if p_observed_schema_fingerprint is distinct from v_source.expected_schema_fingerprint then
    raise exception 'The observed schema fingerprint does not match the declared report schema' using errcode = '22023';
  end if;

  if v_source.lifecycle <> 'approved' then
    update public.service_titan_report_sources source
    set verification = 'inspected', observed_schema_fingerprint = p_observed_schema_fingerprint,
        inspected_at = v_now, lifecycle = 'inspected', updated_at = v_now
    where source.id = v_source.id;
  end if;

  v_delta := p_computed_value - p_reference_value;
  v_approved := pg_catalog.abs(v_delta) <= p_tolerance;

  insert into public.service_titan_report_evidence (
    organization_id, report_source_id, evidence_type, source_fingerprint, status,
    row_count, computed_value, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_source.id, 'sample', v_source.canonical_source_fingerprint, 'pass',
    p_row_count, p_computed_value, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id),
    p_actor_profile_id
  );
  insert into public.service_titan_report_evidence (
    organization_id, report_source_id, evidence_type, source_fingerprint, status,
    expected_value, reference_value, tolerance, delta, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_source.id, 'reconciliation', v_source.canonical_source_fingerprint,
    case when v_approved then 'pass' else 'fail' end,
    p_computed_value, p_reference_value, p_tolerance, v_delta, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id),
    p_actor_profile_id
  );
  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    row_count, computed_value, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'sample', v_binding.canonical_source_fingerprint, 'pass',
    p_row_count, p_computed_value, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id),
    p_actor_profile_id
  );
  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    expected_value, reference_value, tolerance, delta, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'reconciliation', v_binding.canonical_source_fingerprint,
    case when v_approved then 'pass' else 'fail' end,
    p_computed_value, p_reference_value, p_tolerance, v_delta, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id),
    p_actor_profile_id
  );

  if v_approved and v_source.lifecycle <> 'approved' then
    update public.service_titan_report_sources source
    set verification = 'inspected', observed_schema_fingerprint = p_observed_schema_fingerprint,
        inspected_at = pg_catalog.coalesce(source.inspected_at, v_now), lifecycle = 'approved',
        approved_at = v_now, approved_by = p_actor_profile_id, updated_at = v_now
    where source.id = v_source.id;
  end if;
  if v_approved then
    update public.custom_kpi_location_bindings binding
    set approval_status = 'approved', approved_at = v_now, approved_by = p_actor_profile_id,
        approved_report_source_fingerprint = v_source.canonical_source_fingerprint, updated_at = v_now
    where binding.id = v_binding.id;
  end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, p_actor_profile_id, 'servicetitan.saved_report.governance',
    'custom_kpi_location_bindings', v_binding.id,
    pg_catalog.jsonb_build_object('sourceLifecycle', v_source.lifecycle, 'bindingApprovalStatus', v_binding.approval_status),
    pg_catalog.jsonb_build_object('approved', v_approved, 'rowCount', p_row_count, 'delta', v_delta, 'tolerance', p_tolerance),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'approved', v_approved, 'delta', v_delta, 'tolerance', p_tolerance,
    'reportSourceId', v_source.id, 'bindingId', v_binding.id,
    'sourceFingerprint', v_source.canonical_source_fingerprint,
    'bindingFingerprint', v_binding.canonical_source_fingerprint
  );
end;
$$;
revoke all on function public.record_and_approve_service_titan_saved_report(
  uuid, uuid, uuid, uuid, bigint, numeric, numeric, numeric, text, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.record_and_approve_service_titan_saved_report(
  uuid, uuid, uuid, uuid, bigint, numeric, numeric, numeric, text, timestamptz, timestamptz, text
) to service_role;

insert into public.schema_releases (release_marker)
values ('20260819001600_enterprise_admin_hardening');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260819001600_enterprise_admin_hardening'
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) = 36
      and exists (
        select 1 from public.portfolios portfolio
        where portfolio.id = 'c1000000-0000-4000-8000-000000000001'
          and portfolio.slug = 'champions-group' and portfolio.status = 'active'
      )
      and exists (
        select 1 from public.portfolio_memberships membership
        where membership.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
          and membership.role = 'owner' and membership.status = 'active'
      )
      and not exists (
        select 1 from public.organizations organization
        where organization.status = 'active'
          and not exists (
            select 1 from public.portfolio_organizations attachment
            where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
              and attachment.organization_id = organization.id and attachment.status = 'active'
          )
      ) as ready,
    marker.release_marker
  from (
    select release.release_marker from public.schema_releases release
    order by release.released_at desc, release.release_marker desc limit 1
  ) marker;
$$;
revoke all on function public.get_release_readiness() from public;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;

commit;
