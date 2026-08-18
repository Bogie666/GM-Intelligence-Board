-- Fail-closed correction for authenticated connection administration.
-- PL/pgSQL `NULL NOT IN (...)` is NULL, not true; explicit NULL rejection is required.

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

  if actor_role is null or actor_role not in ('owner', 'admin') then
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

  if actor_role is null or actor_role not in ('owner', 'admin') then
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

revoke all on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) to authenticated;
revoke all on function public.disable_service_titan_connection(uuid, uuid) from public, anon;
grant execute on function public.disable_service_titan_connection(uuid, uuid) to authenticated;

comment on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) is
  'Fail-closed authenticated owner/admin transaction for credential-free connection metadata and an optional exact-tenant location assignment.';
comment on function public.disable_service_titan_connection(uuid, uuid) is
  'Fail-closed authenticated owner/admin transaction that disables a connection and revokes all active assignments.';
