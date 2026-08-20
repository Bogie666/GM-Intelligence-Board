-- 020: Admin-created custom endpoint data sources.
-- Tenants may declare additional ServiceTitan list-endpoint sources beyond the
-- migration-owned recipe catalog. Each custom source is a bounded, credential-free
-- contract (governed category, query parameters, reduction, value-field path) that
-- follows the same declared -> inspected -> approved lifecycle and evidence gates
-- as saved reports. Approved custom sources bind to KPIs through
-- custom_kpi_location_bindings with source_method = 'custom_endpoint'.

begin;

create table public.service_titan_custom_endpoint_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  service_titan_tenant_id text not null,
  name text not null,
  description text not null default '',
  category text not null check (category in ('jobs', 'appointments', 'invoices', 'estimates', 'memberships', 'calls', 'customers')),
  query_parameters jsonb not null default '{}'::jsonb,
  reduction text not null check (reduction in ('count', 'sum', 'average')),
  value_field text,
  business_unit_field text,
  canonical_source_fingerprint text not null default '',
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'inspected', 'approved', 'archived')),
  status text not null default 'active' check (status in ('active', 'archived')),
  inspected_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint st_custom_endpoint_connection_fk foreign key (organization_id, connection_id, service_titan_tenant_id)
    references public.service_titan_connections(organization_id, id, service_titan_tenant_id) on delete restrict,
  constraint st_custom_endpoint_name_not_blank check (pg_catalog.btrim(name) <> '' and pg_catalog.length(name) <= 200),
  constraint st_custom_endpoint_description_bounded check (pg_catalog.length(description) <= 500),
  constraint st_custom_endpoint_query_object check (pg_catalog.jsonb_typeof(query_parameters) = 'object'),
  constraint st_custom_endpoint_query_no_credentials check (
    not public.jsonb_has_forbidden_credential_keys(query_parameters)
  ),
  constraint st_custom_endpoint_value_field_shape check (
    (reduction = 'count' and value_field is null)
    or (reduction in ('sum', 'average') and value_field is not null
        and value_field ~ '^[A-Za-z][A-Za-z0-9._]{0,119}$')
  ),
  constraint st_custom_endpoint_bu_field_shape check (
    business_unit_field is null or business_unit_field ~ '^[A-Za-z][A-Za-z0-9._]{0,119}$'
  ),
  constraint st_custom_endpoint_lifecycle_status check ((lifecycle = 'archived') = (status = 'archived')),
  constraint st_custom_endpoint_approval_fields check (
    lifecycle <> 'approved'
    or (status = 'active' and approved_at is not null and approved_by is not null)
  ),
  constraint st_custom_endpoint_org_id_unique unique (organization_id, id),
  constraint st_custom_endpoint_binding_identity_unique unique (organization_id, id, connection_id, service_titan_tenant_id),
  constraint st_custom_endpoint_name_unique unique (organization_id, connection_id, name)
);

create index st_custom_endpoint_org_lifecycle_idx
  on public.service_titan_custom_endpoint_sources (organization_id, lifecycle, status);

comment on table public.service_titan_custom_endpoint_sources is
  'Tenant-declared ServiceTitan list-endpoint source contracts. Governed categories and reductions only; approval requires trusted-worker evidence.';

-- Fingerprint mirrors the saved-report pattern: any contract change produces a new
-- fingerprint, invalidating stale approvals downstream.
create or replace function public.set_custom_endpoint_source_fingerprint()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.canonical_source_fingerprint := public.canonical_source_fingerprint(
    pg_catalog.jsonb_build_object(
      'organizationId', new.organization_id,
      'connectionId', new.connection_id,
      'tenantId', new.service_titan_tenant_id,
      'category', new.category,
      'queryParameters', new.query_parameters,
      'reduction', new.reduction,
      'valueField', new.value_field,
      'businessUnitField', new.business_unit_field
    )
  );
  return new;
end;
$$;
revoke all on function public.set_custom_endpoint_source_fingerprint() from public, anon, authenticated;

create or replace function public.protect_custom_endpoint_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.lifecycle = 'archived' then
    raise exception 'Archived custom endpoint sources are immutable';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.connection_id is distinct from old.connection_id
     or new.service_titan_tenant_id is distinct from old.service_titan_tenant_id then
    raise exception 'Custom endpoint source organization/connection/tenant identity is immutable';
  end if;
  if old.lifecycle = 'approved' then
    if new.lifecycle not in ('approved', 'archived') then
      raise exception 'Approved custom endpoint sources may only remain approved or be archived';
    end if;
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'status', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'status', 'updated_at']) then
      raise exception 'Approved custom endpoint contracts are immutable; create a new source';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_custom_endpoint_source() from public, anon, authenticated;

create trigger st_custom_endpoint_05_protect
before update on public.service_titan_custom_endpoint_sources
for each row execute function public.protect_custom_endpoint_source();
create trigger st_custom_endpoint_10_fingerprint
before insert or update on public.service_titan_custom_endpoint_sources
for each row execute function public.set_custom_endpoint_source_fingerprint();

alter table public.service_titan_custom_endpoint_sources enable row level security;
revoke all on table public.service_titan_custom_endpoint_sources from public, anon, authenticated;
grant select, insert, update, delete on table public.service_titan_custom_endpoint_sources to authenticated;
create policy st_custom_endpoint_admin_read on public.service_titan_custom_endpoint_sources
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_custom_endpoint_admin_insert on public.service_titan_custom_endpoint_sources
for insert to authenticated
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_custom_endpoint_admin_update on public.service_titan_custom_endpoint_sources
for update to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_custom_endpoint_admin_delete on public.service_titan_custom_endpoint_sources
for delete to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

-- ---------- Binding integration ----------

alter table public.custom_kpi_location_bindings
  add column custom_endpoint_source_id uuid,
  add column approved_custom_endpoint_fingerprint text;

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_bindings_custom_endpoint_fk
    foreign key (organization_id, custom_endpoint_source_id, connection_id, service_titan_tenant_id)
    references public.service_titan_custom_endpoint_sources(organization_id, id, connection_id, service_titan_tenant_id)
    on delete restrict;

alter table public.custom_kpi_location_bindings
  drop constraint custom_kpi_binding_source_shape;

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_source_shape check (
    (source_method is null and connection_id is null and service_titan_tenant_id is null
      and endpoint_recipe_id is null and endpoint_recipe_version is null and report_source_id is null
      and custom_endpoint_source_id is null
      and refresh_interval is null and report_reduction is null and canonical_source_fingerprint is null)
    or
    (source_method = 'endpoint_recipe' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is not null and pg_catalog.btrim(endpoint_recipe_id) <> ''
      and endpoint_recipe_version is not null and endpoint_recipe_version > 0
      and report_source_id is null and custom_endpoint_source_id is null
      and refresh_interval is not null and report_reduction is null)
    or
    (source_method = 'saved_report' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is null and endpoint_recipe_version is null
      and report_source_id is not null and custom_endpoint_source_id is null
      and refresh_interval in ('4h', '12h', '24h') and report_reduction is not null)
    or
    (source_method = 'custom_endpoint' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is null and endpoint_recipe_version is null
      and report_source_id is null and custom_endpoint_source_id is not null
      and refresh_interval in ('1h', '4h', '12h', '24h') and report_reduction is null)
  );

alter table public.custom_kpi_location_bindings
  drop constraint custom_kpi_location_bindings_source_method_check;
alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_location_bindings_source_method_check
    check (source_method in ('endpoint_recipe', 'saved_report', 'custom_endpoint'));

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_custom_endpoint_pin_check check (
    (source_method = 'custom_endpoint' and approved_custom_endpoint_fingerprint is not null
      and pg_catalog.btrim(approved_custom_endpoint_fingerprint) <> '')
    or
    (source_method is distinct from 'custom_endpoint' and approved_custom_endpoint_fingerprint is null)
  );

-- Extend fingerprint binding trigger for custom endpoint bindings.
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
begin
  select definition.type into definition_type
  from public.custom_kpi_definitions definition
  where definition.id = new.kpi_definition_id and definition.organization_id = new.organization_id;

  if definition_type is null then
    raise exception 'Unknown KPI definition for location binding';
  end if;
  if definition_type = 'service_titan' and new.source_method is null then
    raise exception 'ServiceTitan KPI location bindings require an endpoint recipe, saved report, or custom endpoint source';
  elsif definition_type <> 'service_titan' and new.source_method is not null then
    raise exception 'Only ServiceTitan KPI definitions may use ServiceTitan source bindings';
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

  if new.source_method is not null and not exists (
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

-- Extend the source-pin trigger for custom endpoint bindings.
create or replace function public.pin_and_protect_saved_report_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_source_fingerprint text;
  current_custom_fingerprint text;
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
  return new;
end;
$$;
revoke all on function public.pin_and_protect_saved_report_binding() from public, anon, authenticated;

-- Extend the authoritative observation gate: valid custom-endpoint observations
-- require the exact currently approved active custom endpoint source.
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
    binding.report_source_id,
    binding.custom_endpoint_source_id,
    binding.approval_status,
    definition.lifecycle as definition_lifecycle,
    organization.status as organization_status,
    location.status as location_status,
    connection.status as connection_status,
    assignment.revoked_at
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
  join public.service_titan_connections connection
    on connection.organization_id = binding.organization_id
   and connection.id = binding.connection_id
   and connection.service_titan_tenant_id = binding.service_titan_tenant_id
  join public.service_titan_connection_locations assignment
    on assignment.organization_id = binding.organization_id
   and assignment.connection_id = binding.connection_id
   and assignment.location_id = binding.location_id
   and assignment.revoked_at is null
  where binding.id = new.binding_id
  for share of binding, definition, location, connection, assignment;

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
       or governed.location_status is distinct from 'active'
       or governed.connection_status is distinct from 'ready'
       or governed.revoked_at is not null then
      raise exception 'Valid observations require a published, approved, active, ready authorization chain';
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
    elsif governed.source_method is distinct from 'endpoint_recipe' then
      raise exception 'Valid ServiceTitan observations require a governed provider source';
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

-- Atomic evidence + approval for custom endpoint sources and their bindings.
create or replace function public.approve_service_titan_custom_endpoint_binding(
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
  v_source public.service_titan_custom_endpoint_sources%rowtype;
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
      and event.action = 'servicetitan.custom_endpoint.governance'
      and event.resource_id = p_binding_id
      and event.request_id = p_request_id
  ) then
    raise exception 'This approval request ID has already been used' using errcode = '23505';
  end if;

  select source.* into v_source
  from public.service_titan_custom_endpoint_sources source
  where source.organization_id = p_organization_id and source.id = p_source_id
  for update;
  if v_source.id is null or v_source.status <> 'active' or v_source.lifecycle = 'archived' then
    raise exception 'The exact active custom endpoint source is unavailable' using errcode = 'P0002';
  end if;

  select binding.* into v_binding
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id and binding.id = p_binding_id
  for update;
  if v_binding.id is null or v_binding.approval_status = 'archived'
     or v_binding.source_method <> 'custom_endpoint'
     or v_binding.custom_endpoint_source_id is distinct from v_source.id
     or v_binding.connection_id is distinct from v_source.connection_id
     or v_binding.service_titan_tenant_id is distinct from v_source.service_titan_tenant_id then
    raise exception 'The binding does not match the exact custom endpoint contract' using errcode = '22023';
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

  if v_binding.approved_custom_endpoint_fingerprint is distinct from v_source.canonical_source_fingerprint then
    raise exception 'The custom endpoint source changed after the binding was drafted; re-save the binding' using errcode = '22023';
  end if;

  v_delta := p_computed_value - p_reference_value;
  v_approved := pg_catalog.abs(v_delta) <= p_tolerance;

  if v_source.lifecycle = 'draft' then
    update public.service_titan_custom_endpoint_sources source
    set lifecycle = 'inspected', inspected_at = v_now, updated_at = v_now
    where source.id = v_source.id;
  end if;

  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    row_count, computed_value, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'sample', v_binding.canonical_source_fingerprint, 'pass',
    p_row_count, p_computed_value, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id, 'method', 'custom_endpoint'),
    p_actor_profile_id
  );
  insert into public.custom_kpi_binding_evidence (
    organization_id, binding_id, evidence_type, source_fingerprint, status,
    expected_value, reference_value, tolerance, delta, observed_at, details, recorded_by
  ) values (
    p_organization_id, v_binding.id, 'reconciliation', v_binding.canonical_source_fingerprint,
    case when v_approved then 'pass' else 'fail' end,
    p_computed_value, p_reference_value, p_tolerance, v_delta, v_now,
    pg_catalog.jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'requestId', p_request_id, 'method', 'custom_endpoint'),
    p_actor_profile_id
  );

  if v_approved then
    update public.service_titan_custom_endpoint_sources source
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
    p_organization_id, p_actor_profile_id, 'servicetitan.custom_endpoint.governance',
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
revoke all on function public.approve_service_titan_custom_endpoint_binding(
  uuid, uuid, uuid, uuid, bigint, numeric, numeric, numeric, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.approve_service_titan_custom_endpoint_binding(
  uuid, uuid, uuid, uuid, bigint, numeric, numeric, numeric, timestamptz, timestamptz, text
) to service_role;

-- Extend the scheduling surface to include approved custom endpoint bindings.
create or replace function public.get_due_custom_endpoint_bindings(p_limit integer default 50)
returns table (
  organization_id uuid,
  binding_id uuid,
  connection_id uuid,
  service_titan_tenant_id text,
  custom_endpoint_source_id uuid,
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
    binding.custom_endpoint_source_id,
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

insert into public.schema_releases (release_marker)
values ('20260820002000_custom_endpoint_sources');

commit;
