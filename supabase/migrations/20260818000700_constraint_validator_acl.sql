-- GM Intelligence Board authenticated constraint-validator ACL release.
-- These pure validators are referenced by CHECK constraints on browser-configurable rows.

insert into public.schema_releases (release_marker)
values ('20260818000700_constraint_validator_acl');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818000700_constraint_validator_acl' as ready,
    marker.release_marker
  from (
    select release.release_marker
    from public.schema_releases release
    order by release.released_at desc, release.release_marker desc
    limit 1
  ) marker;
$$;

-- Both functions are immutable validation predicates: they read no tables, disclose no
-- tenant state, and perform no writes. PostgreSQL must be able to execute them while
-- evaluating authenticated INSERT/UPDATE CHECK constraints.
grant execute on function public.is_finite_numeric(numeric) to authenticated;
grant execute on function public.jsonb_has_forbidden_credential_keys(jsonb) to authenticated;

-- Function replacement can cause platform-managed direct grants; preserve the allowlist.
revoke execute on function public.get_release_readiness() from public;
revoke execute on function public.get_release_readiness() from anon;
revoke execute on function public.get_release_readiness() from authenticated;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;
