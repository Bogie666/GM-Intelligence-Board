-- GM Intelligence Board audit-secret redaction release.
-- Opaque managed-secret locators are operationally sensitive even though they are not raw
-- credentials. They must not be browser-readable through connection rows or audit snapshots.

insert into public.schema_releases (release_marker)
values ('20260818000800_audit_secret_redaction');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818000800_audit_secret_redaction' as ready,
    marker.release_marker
  from (
    select release.release_marker
    from public.schema_releases release
    order by release.released_at desc, release.release_marker desc
    limit 1
  ) marker;
$$;

-- Rebuild the audit constraint after scrubbing any historical locator snapshots. The
-- append-only trigger is disabled only inside this transactional migration and restored
-- before commit. Any error rolls the trigger state and row updates back together.
alter table public.audit_events
  drop constraint if exists audit_events_no_credentials;

alter table public.audit_events disable trigger audit_events_append_only;

update public.audit_events
set before_state = case when before_state is null then null else before_state - 'secret_reference' end,
    after_state = case when after_state is null then null else after_state - 'secret_reference' end
where resource_table = 'service_titan_connections'
  and (
    coalesce(before_state ? 'secret_reference', false)
    or coalesce(after_state ? 'secret_reference', false)
  );

alter table public.audit_events enable trigger audit_events_append_only;

create or replace function public.audit_state_has_forbidden_credentials(payload jsonb, resource_table_name text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select public.jsonb_has_forbidden_credential_keys(payload);
$$;

alter table public.audit_events
  add constraint audit_events_no_credentials check (
    not public.audit_state_has_forbidden_credentials(before_state, resource_table)
    and not public.audit_state_has_forbidden_credentials(after_state, resource_table)
  );

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

  if tg_table_name = 'service_titan_connections' then
    old_row := case when old_row is null then null else old_row - 'secret_reference' end;
    new_row := case when new_row is null then null else new_row - 'secret_reference' end;
  end if;

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

-- Function replacement may materialize direct API-role grants; restore the release allowlist.
revoke execute on function public.get_release_readiness() from public, anon, authenticated;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;
revoke execute on function public.audit_state_has_forbidden_credentials(jsonb, text) from public, anon, authenticated;
revoke execute on function public.record_configuration_audit_event() from public, anon, authenticated;

-- Public Auth signup is denied at the database boundary unless the service-role bootstrap
-- authorizes one exact normalized email for a short, single-use window. This remains effective
-- even when the hosted Auth setting cannot be changed through the Management API.
create table public.pilot_auth_email_authorizations (
  email text primary key,
  expires_at timestamptz not null,
  authorized_at timestamptz not null default pg_catalog.now(),
  constraint pilot_auth_email_normalized check (email = pg_catalog.lower(pg_catalog.btrim(email))),
  constraint pilot_auth_email_shape check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

alter table public.pilot_auth_email_authorizations enable row level security;
revoke all on table public.pilot_auth_email_authorizations from public, anon, authenticated;

create or replace function public.authorize_pilot_auth_email(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required';
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.length(normalized_email) > 254 then
    raise exception 'A valid pilot email is required';
  end if;

  insert into public.pilot_auth_email_authorizations (email, expires_at)
  values (normalized_email, pg_catalog.now() + interval '5 minutes')
  on conflict (email) do update
    set expires_at = excluded.expires_at,
        authorized_at = pg_catalog.now();
  return true;
end;
$$;

create or replace function public.enforce_pilot_auth_email_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  consumed_email text;
begin
  if new.email is null then
    raise exception 'Private pilot Auth users require a preauthorized email';
  end if;

  delete from public.pilot_auth_email_authorizations authz
  where authz.email = pg_catalog.lower(pg_catalog.btrim(new.email))
    and authz.expires_at >= pg_catalog.now()
  returning authz.email into consumed_email;

  if consumed_email is null then
    raise exception 'Auth email is not authorized for the private pilot';
  end if;
  return new;
end;
$$;

create trigger enforce_pilot_auth_email_authorization
before insert on auth.users
for each row execute function public.enforce_pilot_auth_email_authorization();

revoke execute on function public.authorize_pilot_auth_email(text) from public, anon, authenticated;
grant execute on function public.authorize_pilot_auth_email(text) to service_role;
revoke execute on function public.enforce_pilot_auth_email_authorization() from public, anon, authenticated;

-- Migration-time proof that no historical connection audit locator survived.
do $$
begin
  if exists (
    select 1
    from public.audit_events event
    where event.resource_table = 'service_titan_connections'
      and (
        coalesce(event.before_state ? 'secret_reference', false)
        or coalesce(event.after_state ? 'secret_reference', false)
      )
  ) then
    raise exception 'Managed-secret locator remains in a connection audit snapshot';
  end if;
end
$$;
