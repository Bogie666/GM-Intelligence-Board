-- GM Intelligence Board: production-pilot tenant bootstrap and release readiness.
--
-- This is a forward-only migration. The two 20260817 migrations are already applied to
-- isolated staging and must not be rewritten. Tenant bootstrap and QA teardown are callable
-- only by PostgREST's service_role. Browser roles can read only the narrow release marker
-- through get_release_readiness(); they never receive direct access to the marker table.

-- ---------- Reviewer follow-up: governor trigger execution ----------

-- These trigger functions call is_active_organization_governor(), whose EXECUTE privilege is
-- intentionally not granted to authenticated. Run the trigger functions as their trusted
-- owner so ordinary authenticated writes can execute the internal helper without exposing
-- that helper as an RPC. auth.uid() still resolves from the caller's request claims.
alter function public.govern_report_source_approval() security definer;
alter function public.govern_kpi_binding_approval() security definer;
alter function public.govern_kpi_definition_approval() security definer;
alter function public.govern_kpi_target_approval() security definer;

revoke all on function public.govern_report_source_approval() from public;
revoke all on function public.govern_kpi_binding_approval() from public;
revoke all on function public.govern_kpi_definition_approval() from public;
revoke all on function public.govern_kpi_target_approval() from public;

-- ---------- Release marker and low-privilege readiness ----------

create table public.schema_releases (
  release_marker text primary key,
  released_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint schema_releases_marker_format
    check (release_marker ~ '^[0-9]{14}_[a-z0-9_]+$')
);

alter table public.schema_releases enable row level security;

-- No table policy exists. Readiness is deliberately narrower than direct table access.
revoke all privileges on public.schema_releases from public, anon, authenticated;

insert into public.schema_releases (release_marker)
values ('20260818000100_production_pilot');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818000100_production_pilot' as ready,
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

comment on table public.schema_releases is
  'Database-owned deployment markers. Direct API access is denied; use get_release_readiness().';
comment on function public.get_release_readiness() is
  'Low-privilege, read-only readiness RPC. Returns only the latest non-secret release marker.';

-- ---------- Transactional service-role tenant bootstrap ----------

create or replace function public.bootstrap_tenant_owner(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_organization_slug text,
  p_organization_name text
)
returns table (
  profile_id uuid,
  organization_id uuid,
  membership_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  normalized_display_name text := pg_catalog.btrim(p_display_name);
  normalized_slug text := pg_catalog.lower(pg_catalog.btrim(p_organization_slug));
  normalized_organization_name text := pg_catalog.btrim(p_organization_name);
  existing_profile public.profiles%rowtype;
  existing_organization public.organizations%rowtype;
  existing_membership public.organization_memberships%rowtype;
  new_organization_id uuid;
  new_membership_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tenant bootstrap requires the service role' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'user ID is required' using errcode = '22023';
  end if;
  if normalized_email is null
     or pg_catalog.length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'a valid normalized email is required' using errcode = '22023';
  end if;
  if normalized_display_name is null
     or normalized_display_name = ''
     or pg_catalog.length(normalized_display_name) > 120 then
    raise exception 'display name must contain 1 to 120 characters' using errcode = '22023';
  end if;
  if normalized_slug is null
     or normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' then
    raise exception 'organization slug is invalid' using errcode = '22023';
  end if;
  if normalized_organization_name is null
     or normalized_organization_name = ''
     or pg_catalog.length(normalized_organization_name) > 160 then
    raise exception 'organization name must contain 1 to 160 characters' using errcode = '22023';
  end if;

  -- Serialize retries for the same Auth user or slug. This makes concurrent operator retries
  -- deterministic rather than allowing a unique-constraint race after partial inspection.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('gmib-bootstrap-user:' || p_user_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('gmib-bootstrap-slug:' || normalized_slug, 0)
  );

  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = p_user_id
      and pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = normalized_email
  ) then
    raise exception 'Auth user does not exist or email does not match' using errcode = '23503';
  end if;

  select profile.* into existing_profile
  from public.profiles profile
  where profile.id = p_user_id;

  if found and existing_profile.display_name is distinct from normalized_display_name then
    raise exception 'existing profile does not match bootstrap input' using errcode = '23505';
  end if;

  select organization.* into existing_organization
  from public.organizations organization
  where organization.slug = normalized_slug;

  if found then
    if existing_profile.id is null then
      raise exception 'existing organization owner is missing its profile' using errcode = '23505';
    end if;

    select membership.* into existing_membership
    from public.organization_memberships membership
    where membership.organization_id = existing_organization.id
      and membership.profile_id = p_user_id;

    if not found
       or existing_membership.role <> 'owner'
       or existing_membership.status <> 'active'
       or existing_organization.name is distinct from normalized_organization_name then
      raise exception 'organization slug is already in use by a different bootstrap state'
        using errcode = '23505';
    end if;

    if exists (
      select 1
      from public.organization_memberships membership
      where membership.profile_id = p_user_id
        and membership.id <> existing_membership.id
    ) then
      raise exception 'Auth user has memberships outside the requested bootstrap tenant'
        using errcode = '23505';
    end if;

    return query select p_user_id, existing_organization.id, existing_membership.id, false;
    return;
  end if;

  if exists (
    select 1 from public.organization_memberships membership
    where membership.profile_id = p_user_id
  ) then
    raise exception 'Auth user is already attached to another organization' using errcode = '23505';
  end if;

  if existing_profile.id is null then
    insert into public.profiles (id, display_name)
    values (p_user_id, normalized_display_name);
  end if;

  insert into public.organizations (slug, name)
  values (normalized_slug, normalized_organization_name)
  returning id into new_organization_id;

  insert into public.organization_memberships (
    organization_id,
    profile_id,
    role,
    status,
    joined_at
  ) values (
    new_organization_id,
    p_user_id,
    'owner',
    'active',
    pg_catalog.clock_timestamp()
  )
  returning id into new_membership_id;

  return query select p_user_id, new_organization_id, new_membership_id, true;
end;
$$;

revoke all on function public.bootstrap_tenant_owner(uuid, text, text, text, text) from public;
revoke all on function public.bootstrap_tenant_owner(uuid, text, text, text, text) from anon, authenticated;
grant execute on function public.bootstrap_tenant_owner(uuid, text, text, text, text) to service_role;

comment on function public.bootstrap_tenant_owner(uuid, text, text, text, text) is
  'Service-role-only idempotent transaction for an existing Auth user, profile, organization, and first active owner membership.';

-- ---------- Guarded disposable-QA teardown ----------

-- QA teardown is intentionally much narrower than a general tenant deletion API. It accepts
-- only an empty qa-* bootstrap tenant with exactly one owner and no configuration/fact rows.
-- The request-scoped marker lets existing append-only/audit/last-owner triggers permit only
-- this verified transaction; all normal behavior remains fail-closed.
create or replace function public.reject_fact_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_schema = 'public'
     and tg_table_name = 'audit_events'
     and auth.role() = 'service_role'
     and current_setting('app.qa_teardown_organization_id', true) = old.organization_id::text then
    return old;
  end if;
  raise exception '% is append-only; append a replacement fact instead', tg_table_name;
end;
$$;

create or replace function public.record_configuration_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row jsonb;
  new_row jsonb;
  target_organization_id uuid;
  target_resource_id uuid;
  event_action text;
  allowed_tables constant text[] := array[
    'organizations', 'locations', 'organization_memberships',
    'service_titan_connections', 'service_titan_connection_locations', 'service_titan_report_sources',
    'custom_kpi_definitions', 'custom_kpi_location_bindings', 'kpi_targets',
    'layout_templates', 'profile_layouts'
  ];
begin
  if tg_table_schema <> 'public' or not (tg_table_name = any (allowed_tables)) then
    raise exception 'Audit trigger may run only on the approved public configuration tables';
  end if;

  old_row := case when tg_op in ('UPDATE', 'DELETE') then pg_catalog.to_jsonb(old) else null end;
  new_row := case when tg_op in ('INSERT', 'UPDATE') then pg_catalog.to_jsonb(new) else null end;
  target_organization_id := coalesce(
    (new_row ->> 'organization_id')::uuid,
    (old_row ->> 'organization_id')::uuid,
    (new_row ->> 'id')::uuid,
    (old_row ->> 'id')::uuid
  );

  if auth.role() = 'service_role'
     and current_setting('app.qa_teardown_organization_id', true) = target_organization_id::text then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  target_resource_id := coalesce((new_row ->> 'id')::uuid, (old_row ->> 'id')::uuid);
  event_action := pg_catalog.lower(tg_op);

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id, before_state, after_state
  ) values (
    target_organization_id, auth.uid(), event_action, tg_table_name, target_resource_id, old_row, new_row
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_membership_governance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  target_organization_id uuid := coalesce(new.organization_id, old.organization_id);
  removing_active_owner boolean := false;
  verified_qa_teardown boolean := false;
begin
  perform 1
  from public.organizations organization
  where organization.id = target_organization_id
  for update;

  verified_qa_teardown := auth.role() = 'service_role'
    and current_setting('app.qa_teardown_organization_id', true) = target_organization_id::text;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.profile_id is distinct from old.profile_id then
      raise exception 'Membership organization/profile identity is immutable';
    end if;
    removing_active_owner := old.role = 'owner' and old.status = 'active'
      and (new.role <> 'owner' or new.status <> 'active');
  elsif tg_op = 'DELETE' then
    removing_active_owner := old.role = 'owner' and old.status = 'active';
  end if;

  if actor_id is not null then
    select membership.role into actor_role
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.profile_id = actor_id
      and membership.status = 'active';

    if actor_role not in ('owner', 'admin') then
      raise exception 'An active organization owner or admin is required to manage memberships';
    end if;

    if tg_op = 'INSERT' then
      if new.role in ('owner', 'admin') and actor_role <> 'owner' then
        raise exception 'Only owners may grant owner or admin membership';
      end if;
    elsif tg_op = 'UPDATE' then
      if old.role in ('owner', 'admin') or new.role in ('owner', 'admin') then
        if actor_role <> 'owner' then
          raise exception 'Only owners may modify owner or admin memberships';
        end if;
      end if;
      if actor_id = old.profile_id and actor_role = 'admin'
         and old.role is distinct from new.role then
        raise exception 'Admins may not promote or change their own role';
      end if;
    elsif tg_op = 'DELETE' then
      if old.role in ('owner', 'admin') and actor_role <> 'owner' then
        raise exception 'Only owners may delete owner or admin memberships';
      end if;
    end if;
  end if;

  if removing_active_owner and not verified_qa_teardown and not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.role = 'owner'
      and membership.status = 'active'
      and membership.id <> old.id
  ) then
    raise exception 'An organization must retain at least one active owner';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.reject_fact_mutation() from public;
revoke all on function public.record_configuration_audit_event() from public;
revoke all on function public.enforce_membership_governance() from public;

create or replace function public.remove_empty_qa_tenant(
  p_organization_id uuid,
  p_user_id uuid,
  p_expected_slug text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_slug text;
  blocking_row_count bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'QA tenant removal requires the service role' using errcode = '42501';
  end if;
  if p_organization_id is null or p_user_id is null then
    raise exception 'organization ID and user ID are required' using errcode = '22023';
  end if;
  if p_expected_slug is null
     or p_expected_slug !~ '^qa-[a-z0-9][a-z0-9-]{0,59}[a-z0-9]$' then
    raise exception 'QA teardown requires an exact qa-* slug' using errcode = '22023';
  end if;

  select organization.slug into actual_slug
  from public.organizations organization
  where organization.id = p_organization_id
  for update;

  if actual_slug is null or actual_slug is distinct from p_expected_slug then
    raise exception 'organization ID and expected QA slug do not match' using errcode = '22023';
  end if;

  if (select pg_catalog.count(*) from public.organization_memberships membership
      where membership.organization_id = p_organization_id) <> 1
     or not exists (
       select 1 from public.organization_memberships membership
       where membership.organization_id = p_organization_id
         and membership.profile_id = p_user_id
         and membership.role = 'owner'
         and membership.status = 'active'
     ) then
    raise exception 'QA teardown requires exactly the original active owner membership';
  end if;

  if exists (
    select 1 from public.organization_memberships membership
    where membership.profile_id = p_user_id
      and membership.organization_id <> p_organization_id
  ) then
    raise exception 'QA owner has another organization membership';
  end if;

  select pg_catalog.sum(row_count) into blocking_row_count
  from (
    select pg_catalog.count(*) as row_count from public.locations where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_connections where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_connection_locations where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_report_sources where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_report_evidence where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.custom_kpi_definitions where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.custom_kpi_location_bindings where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.custom_kpi_binding_evidence where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.kpi_observations where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.kpi_targets where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.layout_templates where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.profile_layouts where organization_id = p_organization_id
  ) tenant_rows;

  if blocking_row_count <> 0 then
    raise exception 'QA tenant contains configuration or fact rows and will not be removed';
  end if;

  perform pg_catalog.set_config('app.qa_teardown_organization_id', p_organization_id::text, true);

  delete from public.audit_events where organization_id = p_organization_id;
  delete from public.organization_memberships
  where organization_id = p_organization_id and profile_id = p_user_id;
  delete from public.organizations where id = p_organization_id;
  delete from public.profiles where id = p_user_id;

  return true;
end;
$$;

revoke all on function public.remove_empty_qa_tenant(uuid, uuid, text) from public;
revoke all on function public.remove_empty_qa_tenant(uuid, uuid, text) from anon, authenticated;
grant execute on function public.remove_empty_qa_tenant(uuid, uuid, text) to service_role;

comment on function public.remove_empty_qa_tenant(uuid, uuid, text) is
  'Service-role-only teardown for an exact empty qa-* bootstrap tenant. Refuses non-QA, shared, or configured tenants.';

-- ---------- Atomic authenticated connection administration ----------

create or replace function public.register_service_titan_connection(
  p_organization_id uuid,
  p_service_titan_tenant_id text,
  p_display_name text,
  p_environment text,
  p_secret_reference text,
  p_location_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  new_connection_id uuid;
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

  if actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;
  if p_service_titan_tenant_id is null
     or pg_catalog.btrim(p_service_titan_tenant_id) !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' then
    raise exception 'ServiceTitan tenant ID is invalid' using errcode = '22023';
  end if;
  if p_display_name is null or pg_catalog.length(pg_catalog.btrim(p_display_name)) not between 1 and 160 then
    raise exception 'connection display name is invalid' using errcode = '22023';
  end if;
  if p_environment not in ('production', 'integration') then
    raise exception 'connection environment is invalid' using errcode = '22023';
  end if;
  if p_secret_reference is null
     or not public.is_valid_secret_reference(pg_catalog.btrim(p_secret_reference)) then
    raise exception 'approved managed-secret reference is required' using errcode = '22023';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.locations location
    where location.organization_id = p_organization_id
      and location.id = p_location_id
      and location.status = 'active'
  ) then
    raise exception 'active tenant location is invalid' using errcode = '22023';
  end if;

  insert into public.service_titan_connections (
    organization_id, service_titan_tenant_id, display_name, environment,
    secret_reference, capabilities, status, last_validated_at
  ) values (
    p_organization_id, pg_catalog.btrim(p_service_titan_tenant_id),
    pg_catalog.btrim(p_display_name), p_environment,
    pg_catalog.btrim(p_secret_reference), '[]'::jsonb, 'needs_attention', null
  ) returning id into new_connection_id;

  if p_location_id is not null then
    insert into public.service_titan_connection_locations (
      organization_id, connection_id, location_id
    ) values (p_organization_id, new_connection_id, p_location_id);
  end if;

  return new_connection_id;
end;
$$;

revoke all on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) to authenticated;

create or replace function public.disable_service_titan_connection(
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
  changed_count integer;
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

  if actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;

  update public.service_titan_connections
  set status = 'disabled'
  where organization_id = p_organization_id
    and id = p_connection_id
    and status not in ('disabled', 'archived');
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    raise exception 'active connection was not found' using errcode = 'P0002';
  end if;

  update public.service_titan_connection_locations
  set revoked_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id
    and connection_id = p_connection_id
    and revoked_at is null;

  return true;
end;
$$;

revoke all on function public.disable_service_titan_connection(uuid, uuid) from public, anon;
grant execute on function public.disable_service_titan_connection(uuid, uuid) to authenticated;

comment on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) is
  'Authenticated owner/admin transaction for credential-free connection metadata and an optional exact-tenant location assignment.';
comment on function public.disable_service_titan_connection(uuid, uuid) is
  'Authenticated owner/admin transaction that disables a connection and revokes all active assignments.';
