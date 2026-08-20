-- 019: Endpoint ingestion worker rollout.
-- Approved endpoint-recipe bindings become live data paths. This release adds:
--   1. service_titan_endpoint_ingestion_runs — an append-only run ledger for the
--      dedicated endpoint worker (scheduling, attribution, diagnostics).
--   2. approve_service_titan_endpoint_binding — separation-of-duties approval for
--      endpoint-recipe bindings (sample + reconciliation evidence, atomic approval),
--      mirroring the saved-report governance contract.
--   3. get_due_endpoint_bindings — a service-role scheduling view over approved
--      endpoint bindings and their cadences.

begin;

create table public.service_titan_endpoint_ingestion_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  binding_id uuid not null,
  connection_id uuid not null,
  requested_period_start timestamptz not null,
  requested_period_end timestamptz not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  error_code text,
  row_count bigint check (row_count is null or row_count >= 0),
  page_count integer check (page_count is null or page_count >= 0),
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  constraint st_endpoint_runs_binding_fk foreign key (organization_id, binding_id)
    references public.custom_kpi_location_bindings(organization_id, id) on delete restrict,
  constraint st_endpoint_runs_period_order check (requested_period_end > requested_period_start),
  constraint st_endpoint_runs_completion check (
    (status = 'running' and completed_at is null)
    or (status in ('completed', 'failed') and completed_at is not null)
  ),
  constraint st_endpoint_runs_error_shape check (
    (status = 'failed') = (error_code is not null)
  )
);

create index st_endpoint_runs_binding_idx
  on public.service_titan_endpoint_ingestion_runs (organization_id, binding_id, started_at desc);
create index st_endpoint_runs_status_idx
  on public.service_titan_endpoint_ingestion_runs (status, started_at desc);

alter table public.service_titan_endpoint_ingestion_runs enable row level security;
revoke all on table public.service_titan_endpoint_ingestion_runs from public, anon, authenticated;
grant select on table public.service_titan_endpoint_ingestion_runs to authenticated;
create policy st_endpoint_runs_admin_read on public.service_titan_endpoint_ingestion_runs
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

comment on table public.service_titan_endpoint_ingestion_runs is
  'Append-only ledger of dedicated endpoint-worker executions per approved endpoint binding.';

-- Runs are worker-owned facts: the service role inserts and completes them; tenants read.
create or replace function public.reject_endpoint_run_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Endpoint ingestion runs are append-only';
  end if;
  if old.status <> 'running' then
    raise exception 'Completed endpoint ingestion runs are immutable';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.binding_id is distinct from old.binding_id
     or new.connection_id is distinct from old.connection_id
     or new.requested_period_start is distinct from old.requested_period_start
     or new.requested_period_end is distinct from old.requested_period_end
     or new.started_at is distinct from old.started_at then
    raise exception 'Endpoint ingestion run identity is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_endpoint_run_mutation() from public, anon, authenticated;

create trigger st_endpoint_runs_protect
before update or delete on public.service_titan_endpoint_ingestion_runs
for each row execute function public.reject_endpoint_run_mutation();

-- Separation-of-duties approval for endpoint-recipe bindings. The trusted operator
-- runs a live sample through the governed recipe execution and provides an
-- independently reconciled value; evidence and approval are atomic.
create or replace function public.approve_service_titan_endpoint_binding(
  p_organization_id uuid,
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
      and event.action = 'servicetitan.endpoint_binding.governance'
      and event.resource_id = p_binding_id
      and event.request_id = p_request_id
  ) then
    raise exception 'This approval request ID has already been used' using errcode = '23505';
  end if;

  select binding.* into v_binding
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id and binding.id = p_binding_id
  for update;
  if v_binding.id is null or v_binding.approval_status = 'archived'
     or v_binding.source_method <> 'endpoint_recipe'
     or v_binding.canonical_source_fingerprint is null then
    raise exception 'The binding is not a governed endpoint-recipe binding' using errcode = '22023';
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

  if not public.is_endpoint_recipe_refresh_allowed(
    v_binding.endpoint_recipe_id, v_binding.endpoint_recipe_version, v_binding.refresh_interval
  ) then
    raise exception 'The binding cadence is no longer allowlisted for this recipe version' using errcode = '22023';
  end if;

  v_delta := p_computed_value - p_reference_value;
  v_approved := pg_catalog.abs(v_delta) <= p_tolerance;

  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    row_count, computed_value, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'sample', v_binding.canonical_source_fingerprint, 'pass',
    p_row_count, p_computed_value, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id, 'method', 'endpoint_recipe'),
    p_actor_profile_id
  );
  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    expected_value, reference_value, tolerance, delta, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'reconciliation', v_binding.canonical_source_fingerprint,
    case when v_approved then 'pass' else 'fail' end,
    p_computed_value, p_reference_value, p_tolerance, v_delta, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id, 'method', 'endpoint_recipe'),
    p_actor_profile_id
  );

  if v_approved then
    update public.custom_kpi_location_bindings binding
    set approval_status = 'approved', approved_at = v_now, approved_by = p_actor_profile_id,
        updated_at = v_now
    where binding.id = v_binding.id;
  end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, p_actor_profile_id, 'servicetitan.endpoint_binding.governance',
    'custom_kpi_location_bindings', v_binding.id,
    pg_catalog.jsonb_build_object('bindingApprovalStatus', v_binding.approval_status),
    pg_catalog.jsonb_build_object('approved', v_approved, 'rowCount', p_row_count, 'delta', v_delta, 'tolerance', p_tolerance),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'approved', v_approved, 'delta', v_delta, 'tolerance', p_tolerance,
    'bindingId', v_binding.id, 'bindingFingerprint', v_binding.canonical_source_fingerprint
  );
end;
$$;
revoke all on function public.approve_service_titan_endpoint_binding(
  uuid, uuid, uuid, bigint, numeric, numeric, numeric, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.approve_service_titan_endpoint_binding(
  uuid, uuid, uuid, bigint, numeric, numeric, numeric, timestamptz, timestamptz, text
) to service_role;

-- Scheduling surface: approved endpoint bindings whose cadence has elapsed since the
-- most recent valid observation. The worker owns period math; this returns candidates.
create or replace function public.get_due_endpoint_bindings(p_limit integer default 50)
returns table (
  organization_id uuid,
  binding_id uuid,
  connection_id uuid,
  service_titan_tenant_id text,
  endpoint_recipe_id text,
  endpoint_recipe_version integer,
  refresh_interval text,
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
  'Service-role scheduling surface: approved endpoint-recipe bindings whose refresh cadence has elapsed.';

insert into public.schema_releases (release_marker)
values ('20260820001900_endpoint_ingestion_worker');

create or replace function public.get_endpoint_ingestion_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_catalog.to_regclass('public.service_titan_endpoint_ingestion_runs') is not null
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820001900_endpoint_ingestion_worker'
      ) as ready,
    '20260820001900_endpoint_ingestion_worker'::text as release_marker;
$$;
revoke all on function public.get_endpoint_ingestion_release_readiness() from public;
grant execute on function public.get_endpoint_ingestion_release_readiness() to anon, authenticated, service_role;

commit;
