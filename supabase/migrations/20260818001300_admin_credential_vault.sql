begin;

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
    or value ~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
$$;

revoke all on function public.is_operator_resolvable_secret_reference(text) from public, anon, authenticated;
comment on function public.is_operator_resolvable_secret_reference(text) is
  'Exact allowlist for secret-reference schemes implemented by trusted ServiceTitan workers, including canonical Supabase Vault UUID references.';

-- Browser onboarding now owns Vault reference creation. The legacy metadata RPC remains in
-- the catalog for forward compatibility but is no longer callable by browser roles.
revoke all on function public.register_service_titan_connection(uuid, text, text, text, text, uuid)
  from public, anon, authenticated;

-- UI controls are mirrored at the storage boundary so direct PostgREST writes cannot bypass
-- the supported United States timezone list.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.locations'::pg_catalog.regclass
      and conname = 'locations_supported_us_timezone_check'
  ) then
    alter table public.locations
      add constraint locations_supported_us_timezone_check
      check (timezone = any (array[
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
        'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'
      ]::text[])) not valid;
  end if;
end;
$$;
alter table public.locations validate constraint locations_supported_us_timezone_check;

-- Secure browser onboarding for ServiceTitan credentials. Credential values cross TLS only
-- into this owner/admin SECURITY DEFINER transaction, are encrypted by Supabase Vault, and
-- are never persisted in application tables or configuration audit snapshots.
create or replace function public.register_service_titan_connection_with_credentials(
  p_organization_id uuid,
  p_service_titan_tenant_id text,
  p_display_name text,
  p_environment text,
  p_client_id text,
  p_client_secret text,
  p_app_key text,
  p_location_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  new_connection_id uuid := extensions.gen_random_uuid();
  vault_secret_id uuid;
  vault_payload text;
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
  if p_display_name is null or pg_catalog.length(pg_catalog.btrim(p_display_name)) not between 1 and 160
     or p_display_name ~ '[[:cntrl:]]' then
    raise exception 'connection display name is invalid' using errcode = '22023';
  end if;
  if p_environment not in ('production', 'integration') then
    raise exception 'connection environment is invalid' using errcode = '22023';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.locations location
    where location.organization_id = p_organization_id
      and location.id = p_location_id
      and location.status = 'active'
  ) then
    raise exception 'active tenant location is invalid' using errcode = '22023';
  end if;

  if p_client_id is null or pg_catalog.length(p_client_id) not between 1 and 4096
     or p_client_id <> pg_catalog.btrim(p_client_id) or p_client_id ~ '[[:cntrl:]]' then
    raise exception 'ServiceTitan client ID is invalid' using errcode = '22023';
  end if;
  if p_client_secret is null or pg_catalog.length(p_client_secret) not between 1 and 4096
     or p_client_secret <> pg_catalog.btrim(p_client_secret) or p_client_secret ~ '[[:cntrl:]]' then
    raise exception 'ServiceTitan client secret is invalid' using errcode = '22023';
  end if;
  if p_app_key is null or pg_catalog.length(p_app_key) not between 1 and 4096
     or p_app_key <> pg_catalog.btrim(p_app_key) or p_app_key ~ '[[:cntrl:]]' then
    raise exception 'ServiceTitan App Key is invalid' using errcode = '22023';
  end if;

  vault_payload := pg_catalog.jsonb_build_object(
    'clientId', p_client_id,
    'clientSecret', p_client_secret,
    'appKey', p_app_key
  )::text;

  vault_secret_id := vault.create_secret(
    vault_payload,
    'gm-intelligence-servicetitan-' || new_connection_id::text,
    'GM Intelligence encrypted ServiceTitan credential for connection ' || new_connection_id::text,
    null
  );

  insert into public.service_titan_connections (
    id, organization_id, service_titan_tenant_id, display_name, environment,
    secret_reference, capabilities, status, last_validated_at
  ) values (
    new_connection_id, p_organization_id, pg_catalog.btrim(p_service_titan_tenant_id),
    pg_catalog.btrim(p_display_name), p_environment,
    'supabase-vault://' || vault_secret_id::text, '[]'::jsonb, 'needs_attention', null
  );

  if p_location_id is not null then
    insert into public.service_titan_connection_locations (
      organization_id, connection_id, location_id
    ) values (p_organization_id, new_connection_id, p_location_id);
  end if;

  return new_connection_id;
end;
$$;

-- Trusted workers resolve only the exact active connection's Vault secret. The Vault row name
-- must be bound to the connection ID so an arbitrary leaked Vault UUID cannot be used as a
-- cross-tenant confused-deputy reference. Successful reads add a credential-free audit event.
create or replace function public.resolve_service_titan_connection_secret(
  p_organization_id uuid,
  p_connection_id uuid,
  p_purpose text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reference text;
  secret_id uuid;
  resolved_secret text;
  expected_name text := 'gm-intelligence-servicetitan-' || p_connection_id::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_purpose not in ('validation', 'ingestion') then
    raise exception 'credential access purpose is invalid' using errcode = '22023';
  end if;

  select connection.secret_reference into reference
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived');

  if reference is null
     or reference !~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'connection does not use a resolvable Vault credential' using errcode = '22023';
  end if;

  secret_id := pg_catalog.replace(reference, 'supabase-vault://', '')::uuid;
  select secret.decrypted_secret into resolved_secret
  from vault.decrypted_secrets secret
  where secret.id = secret_id
    and secret.name = expected_name;

  if resolved_secret is null then
    raise exception 'managed Vault credential is unavailable' using errcode = 'P0002';
  end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, null, 'servicetitan.secret.resolve.' || p_purpose,
    'service_titan_connections', p_connection_id, null, null,
    pg_catalog.current_setting('request.id', true)
  );

  return resolved_secret;
end;
$$;

-- Owners/admins can correct or rotate a credential without exposing the previous value. Vault
-- updates and connection revalidation state changes are atomic.
create or replace function public.rotate_service_titan_connection_credentials(
  p_organization_id uuid,
  p_connection_id uuid,
  p_client_id text,
  p_client_secret text,
  p_app_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  reference text;
  secret_id uuid;
  expected_name text := 'gm-intelligence-servicetitan-' || p_connection_id::text;
  vault_payload text;
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

  if p_client_id is null or pg_catalog.length(p_client_id) not between 1 and 4096
     or p_client_id <> pg_catalog.btrim(p_client_id) or p_client_id ~ '[[:cntrl:]]'
     or p_client_secret is null or pg_catalog.length(p_client_secret) not between 1 and 4096
     or p_client_secret <> pg_catalog.btrim(p_client_secret) or p_client_secret ~ '[[:cntrl:]]'
     or p_app_key is null or pg_catalog.length(p_app_key) not between 1 and 4096
     or p_app_key <> pg_catalog.btrim(p_app_key) or p_app_key ~ '[[:cntrl:]]' then
    raise exception 'ServiceTitan credential is invalid' using errcode = '22023';
  end if;

  select connection.secret_reference into reference
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived')
  for update;
  if reference is null
     or reference !~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'active Vault-backed connection was not found' using errcode = 'P0002';
  end if;

  secret_id := pg_catalog.replace(reference, 'supabase-vault://', '')::uuid;
  if not exists (select 1 from vault.secrets secret where secret.id = secret_id and secret.name = expected_name) then
    raise exception 'managed Vault credential is unavailable' using errcode = 'P0002';
  end if;

  vault_payload := pg_catalog.jsonb_build_object(
    'clientId', p_client_id, 'clientSecret', p_client_secret, 'appKey', p_app_key
  )::text;
  perform vault.update_secret(
    secret_id, vault_payload, expected_name,
    'GM Intelligence encrypted ServiceTitan credential for connection ' || p_connection_id::text,
    null
  );

  update public.service_titan_connections
  set status = 'needs_attention', capabilities = '[]'::jsonb, last_validated_at = null
  where organization_id = p_organization_id and id = p_connection_id;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'servicetitan.secret.rotate',
    'service_titan_connections', p_connection_id, null, null,
    pg_catalog.current_setting('request.id', true)
  );
  return true;
end;
$$;

-- Disabling a Vault-backed connection also destroys its encrypted secret in the same transaction.
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
  reference text;
  secret_id uuid;
  expected_name text := 'gm-intelligence-servicetitan-' || p_connection_id::text;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid()
    and membership.status = 'active' and organization.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;

  select connection.secret_reference into reference
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived')
  for update;
  if reference is null then
    raise exception 'active connection was not found' using errcode = 'P0002';
  end if;

  update public.service_titan_connections set status = 'disabled'
  where organization_id = p_organization_id and id = p_connection_id;
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    raise exception 'active connection was not found' using errcode = 'P0002';
  end if;

  update public.service_titan_connection_locations
  set revoked_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and connection_id = p_connection_id and revoked_at is null;

  if reference ~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    secret_id := pg_catalog.replace(reference, 'supabase-vault://', '')::uuid;
    delete from vault.secrets secret where secret.id = secret_id and secret.name = expected_name;
    if not found then
      raise exception 'managed Vault credential retirement failed' using errcode = 'P0002';
    end if;
    insert into public.audit_events (
      organization_id, actor_profile_id, action, resource_table, resource_id,
      before_state, after_state, request_id
    ) values (
      p_organization_id, auth.uid(), 'servicetitan.secret.retire',
      'service_titan_connections', p_connection_id, null, null,
      pg_catalog.current_setting('request.id', true)
    );
  end if;
  return true;
end;
$$;

revoke all on function public.register_service_titan_connection_with_credentials(uuid, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.register_service_titan_connection_with_credentials(uuid, text, text, text, text, text, text, uuid) to authenticated;
revoke all on function public.rotate_service_titan_connection_credentials(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.rotate_service_titan_connection_credentials(uuid, uuid, text, text, text) to authenticated;
revoke all on function public.resolve_service_titan_connection_secret(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_service_titan_connection_secret(uuid, uuid, text) to service_role;

comment on function public.register_service_titan_connection_with_credentials(uuid, text, text, text, text, text, text, uuid) is
  'Authenticated owner/admin transaction that encrypts ServiceTitan credentials in Supabase Vault and stores only a connection-bound opaque reference.';
comment on function public.rotate_service_titan_connection_credentials(uuid, uuid, text, text, text) is
  'Authenticated owner/admin transaction that atomically replaces an exact connection-bound Vault credential and requires revalidation.';
comment on function public.resolve_service_titan_connection_secret(uuid, uuid, text) is
  'Service-role-only audited resolver for an exact enabled ServiceTitan connection and exact connection-bound Vault secret.';
comment on function public.disable_service_titan_connection(uuid, uuid) is
  'Authenticated owner/admin transaction that disables a connection, revokes assignments, and atomically destroys connection-bound Vault credentials.';

insert into public.schema_releases (release_marker)
values ('20260818001300_admin_credential_vault');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818001300_admin_credential_vault'
      and exists (
        select 1 from public.portfolios portfolio
        where portfolio.id = 'c1000000-0000-4000-8000-000000000001'
          and portfolio.slug = 'champions-group' and portfolio.status = 'active'
      )
      and exists (
        select 1 from public.portfolio_memberships membership
        where membership.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
          and membership.role = 'owner' and membership.status = 'active'
      )
      and not exists (
        select 1 from public.organizations organization
        where organization.status = 'active'
          and not exists (
            select 1 from public.portfolio_organizations attachment
            where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
              and attachment.organization_id = organization.id and attachment.status = 'active'
          )
      ) as ready,
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
