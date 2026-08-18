begin;

create or replace function public.grant_owner_access_to_all_tenants(p_profile_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_tenant_count integer;
  granted_tenant_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if p_profile_id is null or not exists (
    select 1 from public.profiles profile where profile.id = p_profile_id
  ) then
    raise exception 'target profile does not exist' using errcode = '22023';
  end if;

  -- Serialize both tenant creation and membership mutation for the grant's short transaction.
  lock table public.organizations in share mode;
  lock table public.organization_memberships in share row exclusive mode;

  if exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.profile_id = p_profile_id
      and organization.status = 'active'
      and (membership.role <> 'owner' or membership.status <> 'active')
  ) then
    raise exception 'an active tenant has conflicting existing membership state' using errcode = '23514';
  end if;

  insert into public.organization_memberships (
    organization_id,
    profile_id,
    role,
    status,
    joined_at
  )
  select organization.id, p_profile_id, 'owner', 'active', pg_catalog.now()
  from public.organizations organization
  where organization.status = 'active'
  on conflict (organization_id, profile_id) do nothing;

  select pg_catalog.count(*)::integer into active_tenant_count
  from public.organizations organization
  where organization.status = 'active';

  select pg_catalog.count(*)::integer into granted_tenant_count
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.profile_id = p_profile_id
    and membership.role = 'owner'
    and membership.status = 'active'
    and organization.status = 'active';

  if granted_tenant_count <> active_tenant_count then
    raise exception 'owner grant incomplete: % of % active tenants', granted_tenant_count, active_tenant_count using errcode = '23514';
  end if;
  return granted_tenant_count;
end;
$$;

revoke all on function public.grant_owner_access_to_all_tenants(uuid) from public, anon, authenticated;
grant execute on function public.grant_owner_access_to_all_tenants(uuid) to service_role;
comment on function public.grant_owner_access_to_all_tenants(uuid) is
  'Service-role operator grant that atomically gives one profile explicit owner membership in every active tenant. Rerun after tenant onboarding.';

insert into public.schema_releases (release_marker)
values ('20260818000900_multi_tenant_operator_access');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818000900_multi_tenant_operator_access' as ready,
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

commit;
