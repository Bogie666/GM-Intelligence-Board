-- GM Intelligence Board public function ACL fail-closed release.
-- Supabase may materialize direct API-role EXECUTE grants at function creation time, so
-- this migration explicitly defines the complete anonymous and authenticated RPC surface.

insert into public.schema_releases (release_marker)
values ('20260818000600_acl_fail_closed');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818000600_acl_fail_closed' as ready,
    marker.release_marker
  from (
    select release.release_marker
    from public.schema_releases release
    order by release.released_at desc, release.release_marker desc
    limit 1
  ) marker;
$$;

-- Remove inherited/default API execution and all direct API-role execution first.
alter default privileges for role postgres in schema public revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public revoke execute on functions from authenticated;
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

-- Anonymous users may only inspect the non-secret release marker.
grant execute on function public.get_release_readiness() to anon;

-- Authenticated browser sessions need only readiness, RLS policy predicates, and the two
-- atomic ServiceTitan connection administration RPCs. Trigger/governance functions stay
-- non-executable directly and still run through their database-owned trigger boundary.
grant execute on function public.get_release_readiness() to authenticated;
grant execute on function public.is_active_organization_member(uuid) to authenticated;
grant execute on function public.has_organization_role(uuid, text[]) to authenticated;
grant execute on function public.can_read_profile(uuid) to authenticated;
grant execute on function public.can_view_kpi_definition(uuid, uuid) to authenticated;
grant execute on function public.can_view_current_kpi_observation(uuid, uuid, text, bigint, text) to authenticated;
grant execute on function public.register_service_titan_connection(uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.disable_service_titan_connection(uuid, uuid) to authenticated;

-- Trusted operator/worker RPCs remain explicit even if platform defaults change.
grant execute on function public.get_release_readiness() to service_role;
grant execute on function public.bootstrap_tenant_owner(uuid, text, text, text, text) to service_role;
grant execute on function public.remove_empty_qa_tenant(uuid, uuid, text) to service_role;
