-- GM Intelligence Board production release gate.
-- Advances the immutable release marker, restricts connection administration to RPCs,
-- hides managed-secret locators from browser roles, enforces KPI role visibility, and
-- makes the complete live-observation authorization chain authoritative at insert/read.

-- ---------- Final release marker ----------

insert into public.schema_releases (release_marker)
values ('20260818000500_production_release');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818000500_production_release' as ready,
    marker.release_marker
  from (
    select release.release_marker
    from public.schema_releases release
    order by release.released_at desc, release.release_marker desc
    limit 1
  ) marker;
$$;

revoke all on function public.get_release_readiness() from public;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;

-- ---------- Connection trust boundary ----------

-- Browser administrators use register_service_titan_connection() and
-- disable_service_titan_connection(). Validation-owned fields remain worker-only.
drop policy if exists st_connections_admin_insert on public.service_titan_connections;
drop policy if exists st_connections_admin_update on public.service_titan_connections;
drop policy if exists st_connections_admin_delete on public.service_titan_connections;
revoke insert, update, delete on public.service_titan_connections from authenticated;

-- Connection/location assignments are part of the same trust boundary. Browser admins
-- create and revoke them only through the atomic connection RPCs.
drop policy if exists st_connection_locations_admin_insert on public.service_titan_connection_locations;
drop policy if exists st_connection_locations_admin_update on public.service_titan_connection_locations;
drop policy if exists st_connection_locations_admin_delete on public.service_titan_connection_locations;
revoke insert, update, delete on public.service_titan_connection_locations from authenticated;

-- Secret references are infrastructure locators and are not exposed through PostgREST.
-- Operator workers retain service_role access.
revoke select on public.service_titan_connections from authenticated;
grant select (
  id, organization_id, service_titan_tenant_id, display_name, environment,
  capabilities, status, last_validated_at, created_at, updated_at
) on public.service_titan_connections to authenticated;

-- ---------- Role-aware KPI visibility ----------

create or replace function public.can_view_kpi_definition(
  p_organization_id uuid,
  p_kpi_definition_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
    join public.custom_kpi_definitions definition
      on definition.organization_id = membership.organization_id
     and definition.id = p_kpi_definition_id
    where membership.organization_id = p_organization_id
      and membership.profile_id = auth.uid()
      and membership.status = 'active'
      and (
        membership.role in ('owner', 'admin')
        or definition.viewer_roles ? membership.role
      )
  );
$$;

revoke all on function public.can_view_kpi_definition(uuid, uuid) from public;
grant execute on function public.can_view_kpi_definition(uuid, uuid) to authenticated;

drop policy if exists custom_kpi_definitions_member_read on public.custom_kpi_definitions;
create policy custom_kpi_definitions_role_read on public.custom_kpi_definitions
for select to authenticated
using (public.can_view_kpi_definition(organization_id, id));

drop policy if exists custom_kpi_bindings_member_read on public.custom_kpi_location_bindings;
create policy custom_kpi_bindings_role_read on public.custom_kpi_location_bindings
for select to authenticated
using (public.can_view_kpi_definition(organization_id, kpi_definition_id));

drop policy if exists st_report_sources_member_read on public.service_titan_report_sources;
create policy st_report_sources_admin_read on public.service_titan_report_sources
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

drop policy if exists st_report_evidence_member_read on public.service_titan_report_evidence;
create policy st_report_evidence_admin_read on public.service_titan_report_evidence
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

drop policy if exists custom_kpi_binding_evidence_member_read on public.custom_kpi_binding_evidence;
create policy custom_kpi_binding_evidence_admin_read on public.custom_kpi_binding_evidence
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));

-- ---------- Authoritative observation materialization gate ----------

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
  -- Lock every row in the operational authorization chain so a kill switch,
  -- assignment revocation, source archive, or approval withdrawal cannot race the insert.
  select
    binding.organization_id,
    binding.kpi_definition_id,
    binding.location_id,
    binding.source_method,
    binding.endpoint_recipe_version,
    binding.canonical_source_fingerprint,
    binding.approved_report_source_fingerprint,
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
        and source.id = (
          select binding.report_source_id
          from public.custom_kpi_location_bindings binding
          where binding.id = new.binding_id
        )
      for share;

      if governed_source_lifecycle is distinct from 'approved'
         or governed_source_status is distinct from 'active'
         or governed_source_fingerprint is null
         or governed.approved_report_source_fingerprint is distinct from governed_source_fingerprint then
        raise exception 'Valid saved-report observations require the exact currently approved report source';
      end if;
    elsif governed.source_method is distinct from 'endpoint_recipe' then
      raise exception 'Valid ServiceTitan observations require a governed provider source';
    end if;

    if new.source_fingerprint is distinct from governed.canonical_source_fingerprint
       or new.source_version is distinct from (
         case
           when governed.source_method = 'endpoint_recipe' then governed.endpoint_recipe_version::bigint
           else 1::bigint
         end
       ) then
      raise exception 'Observation source fingerprint/version does not match the current governed binding';
    end if;
  end if;

  new.source_fingerprint := governed.canonical_source_fingerprint;
  return new;
end;
$$;

alter table public.kpi_observations
  add constraint kpi_observations_idempotency_sha256_check
  check (idempotency_key ~ '^[0-9a-f]{64}$') not valid;
alter table public.kpi_observations
  validate constraint kpi_observations_idempotency_sha256_check;

-- Current observations disappear immediately when any operational gate is withdrawn.
create or replace function public.can_view_current_kpi_observation(
  p_organization_id uuid,
  p_binding_id uuid,
  p_source_fingerprint text,
  p_source_version bigint,
  p_status text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_status = 'valid' and exists (
    select 1
    from public.custom_kpi_location_bindings binding
    join public.organizations organization
      on organization.id = binding.organization_id
     and organization.status = 'active'
    join public.custom_kpi_definitions definition
      on definition.organization_id = binding.organization_id
     and definition.id = binding.kpi_definition_id
    join public.organization_memberships membership
      on membership.organization_id = binding.organization_id
     and membership.profile_id = auth.uid()
     and membership.status = 'active'
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
    left join public.service_titan_report_sources source
      on source.organization_id = binding.organization_id
     and source.id = binding.report_source_id
     and source.connection_id = binding.connection_id
     and source.service_titan_tenant_id = binding.service_titan_tenant_id
    where binding.id = p_binding_id
      and binding.organization_id = p_organization_id
      and binding.approval_status = 'approved'
      and definition.lifecycle = 'published'
      and (membership.role in ('owner', 'admin') or definition.viewer_roles ? membership.role)
      and binding.canonical_source_fingerprint = p_source_fingerprint
      and p_source_version = (
        case
          when binding.source_method = 'endpoint_recipe' then binding.endpoint_recipe_version::bigint
          else 1::bigint
        end
      )
      and (
        binding.source_method = 'endpoint_recipe'
        or (
          binding.source_method = 'saved_report'
          and source.lifecycle = 'approved'
          and source.status = 'active'
          and binding.approved_report_source_fingerprint = source.canonical_source_fingerprint
        )
      )
  );
$$;

revoke all on function public.can_view_current_kpi_observation(uuid, uuid, text, bigint, text) from public;
grant execute on function public.can_view_current_kpi_observation(uuid, uuid, text, bigint, text) to authenticated;

drop policy if exists kpi_observations_member_read on public.kpi_observations;
create policy kpi_observations_current_role_read on public.kpi_observations
for select to authenticated
using (public.can_view_current_kpi_observation(
  organization_id, binding_id, source_fingerprint, source_version, status
));
