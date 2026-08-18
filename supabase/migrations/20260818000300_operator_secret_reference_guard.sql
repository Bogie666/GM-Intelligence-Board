-- Restrict pilot ServiceTitan connection references to the secret resolvers
-- implemented by the operator validation path. Additional providers require a
-- forward migration plus a tested resolver before they can be stored.

create or replace function public.is_operator_resolvable_secret_reference(value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select value is not null and (
    value ~ '^gcp-secret://projects/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/secrets/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/versions/(latest|[1-9][0-9]*)$'
    or value ~ '^env://[A-Z][A-Z0-9_]{1,127}$'
  );
$$;

revoke all on function public.is_operator_resolvable_secret_reference(text) from public;
revoke all on function public.is_operator_resolvable_secret_reference(text) from anon;
revoke all on function public.is_operator_resolvable_secret_reference(text) from authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'service_titan_connections_operator_resolvable_secret_check'
      and conrelid = 'public.service_titan_connections'::regclass
  ) then
    alter table public.service_titan_connections
      add constraint service_titan_connections_operator_resolvable_secret_check
      check (public.is_operator_resolvable_secret_reference(secret_reference)) not valid;
  end if;
end;
$$;

alter table public.service_titan_connections
  validate constraint service_titan_connections_operator_resolvable_secret_check;

comment on function public.is_operator_resolvable_secret_reference(text) is
  'Pilot allowlist for exact secret-reference shapes supported by the tested ServiceTitan operator resolver.';
