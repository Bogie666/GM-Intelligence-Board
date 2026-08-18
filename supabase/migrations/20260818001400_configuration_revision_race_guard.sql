begin;

-- Every credential set has a non-secret revision used for compare-and-set worker updates.
alter table public.service_titan_connections
  add column if not exists configuration_revision uuid;

update public.service_titan_connections
set configuration_revision = extensions.gen_random_uuid()
where configuration_revision is null;

alter table public.service_titan_connections
  alter column configuration_revision set default extensions.gen_random_uuid(),
  alter column configuration_revision set not null;

comment on column public.service_titan_connections.configuration_revision is
  'Non-secret compare-and-set revision changed atomically whenever encrypted credentials rotate.';

-- Ingestion may resolve credentials only while the connection is ready. Validation may resolve
-- an enabled connection while it is being brought back to ready.
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
    and (
      (p_purpose = 'ingestion' and connection.status = 'ready')
      or (p_purpose = 'validation' and connection.status not in ('disabled', 'archived'))
    );

  if reference is null
     or reference !~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'connection does not use a resolvable Vault credential for this operation'
      using errcode = '22023';
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

-- Rotation deletes the previous Vault row and creates a new UUID/reference and revision in one
-- transaction. Any validator holding the prior pair can no longer mark the replacement ready.
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
  new_secret_id uuid;
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
  if not exists (
    select 1 from vault.secrets secret
    where secret.id = secret_id and secret.name = expected_name
  ) then
    raise exception 'managed Vault credential is unavailable' using errcode = 'P0002';
  end if;

  vault_payload := pg_catalog.jsonb_build_object(
    'clientId', p_client_id, 'clientSecret', p_client_secret, 'appKey', p_app_key
  )::text;

  delete from vault.secrets secret
  where secret.id = secret_id and secret.name = expected_name;
  new_secret_id := vault.create_secret(
    vault_payload,
    expected_name,
    'GM Intelligence encrypted ServiceTitan credential for connection ' || p_connection_id::text,
    null
  );

  update public.service_titan_connections
  set secret_reference = 'supabase-vault://' || new_secret_id::text,
      configuration_revision = extensions.gen_random_uuid(),
      status = 'needs_attention',
      capabilities = '[]'::jsonb,
      last_validated_at = null
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

-- Saved-report workers submit a transient revision with an observation. The connection row is
-- share-locked against rotation, stale revisions are rejected, and the revision is stripped before
-- storage so it never enters browser-visible observation metadata.
create or replace function public.enforce_service_titan_observation_configuration_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  binding_source_method text;
  binding_connection_id uuid;
  expected_revision_text text;
  current_revision uuid;
  current_status text;
begin
  select binding.source_method, binding.connection_id
    into binding_source_method, binding_connection_id
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = new.organization_id
    and binding.id = new.binding_id;

  if binding_source_method is distinct from 'saved_report' then
    return new;
  end if;

  expected_revision_text := new.metadata ->> '_credentialRevision';
  if expected_revision_text is null
     or expected_revision_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'saved-report observation credential revision is required'
      using errcode = '40001';
  end if;

  select connection.configuration_revision, connection.status
    into current_revision, current_status
  from public.service_titan_connections connection
  where connection.organization_id = new.organization_id
    and connection.id = binding_connection_id
  for share;

  if current_revision is null
     or current_status is distinct from 'ready'
     or current_revision::text is distinct from expected_revision_text then
    raise exception 'ServiceTitan credential revision changed during ingestion'
      using errcode = '40001';
  end if;

  new.metadata := new.metadata - '_credentialRevision';
  return new;
end;
$$;

revoke all on function public.enforce_service_titan_observation_configuration_revision()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_service_titan_observation_configuration_revision
  on public.kpi_observations;
create trigger enforce_service_titan_observation_configuration_revision
before insert on public.kpi_observations
for each row execute function public.enforce_service_titan_observation_configuration_revision();

revoke all on function public.resolve_service_titan_connection_secret(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_service_titan_connection_secret(uuid, uuid, text)
  to service_role;
revoke all on function public.rotate_service_titan_connection_credentials(uuid, uuid, text, text, text)
  from public, anon;
grant execute on function public.rotate_service_titan_connection_credentials(uuid, uuid, text, text, text)
  to authenticated;

comment on function public.enforce_service_titan_observation_configuration_revision() is
  'Serializes saved-report observation writes against credential rotation and strips the transient worker revision.';
comment on function public.rotate_service_titan_connection_credentials(uuid, uuid, text, text, text) is
  'Atomically changes Vault UUID/reference and credential revision so stale worker updates fail closed.';
comment on function public.resolve_service_titan_connection_secret(uuid, uuid, text) is
  'Service-role-only resolver requiring ready status for ingestion and an exact connection-bound Vault secret.';

insert into public.schema_releases (release_marker)
values ('20260818001400_configuration_revision_race_guard');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818001400_configuration_revision_race_guard'
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
