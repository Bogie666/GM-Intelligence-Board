begin;

-- Forward-only repair for early production tenants whose release ledger predates the
-- normalized endpoint-recipe cadence allowlist now present in the canonical initial schema.
-- Existing canonical installations are unchanged; missing installations receive the exact
-- migration-owned 21-row v1 policy before any KPI catalog references are validated.
create table if not exists public.service_titan_endpoint_recipe_refresh_policies (
  endpoint_recipe_id text not null,
  endpoint_recipe_version integer not null check (endpoint_recipe_version > 0),
  refresh_interval text not null check (refresh_interval in ('15m', '30m', '1h', '4h', '24h')),
  constraint st_endpoint_recipe_policy_id_not_blank check (pg_catalog.btrim(endpoint_recipe_id) <> ''),
  constraint st_endpoint_recipe_refresh_policy_pk
    primary key (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
);
insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
values
  ('completed-revenue',1,'15m'),('completed-revenue',1,'30m'),('completed-revenue',1,'1h'),
  ('completed-revenue',1,'4h'),('completed-revenue',1,'24h'),
  ('completed-appointments',1,'15m'),('completed-appointments',1,'30m'),('completed-appointments',1,'1h'),
  ('completed-appointments',1,'4h'),('completed-appointments',1,'24h'),
  ('sales-close-rate',1,'30m'),('sales-close-rate',1,'1h'),('sales-close-rate',1,'4h'),('sales-close-rate',1,'24h'),
  ('active-memberships',1,'1h'),('active-memberships',1,'4h'),('active-memberships',1,'24h'),
  ('inbound-call-booking-rate',1,'15m'),('inbound-call-booking-rate',1,'30m'),
  ('inbound-call-booking-rate',1,'1h'),('inbound-call-booking-rate',1,'4h')
on conflict do nothing;
create or replace function public.is_endpoint_recipe_refresh_allowed(
  target_recipe_id text, target_recipe_version integer, target_refresh_interval text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.service_titan_endpoint_recipe_refresh_policies policy
    where policy.endpoint_recipe_id = target_recipe_id
      and policy.endpoint_recipe_version = target_recipe_version
      and policy.refresh_interval = target_refresh_interval
  );
$$;
revoke all on function public.is_endpoint_recipe_refresh_allowed(text, integer, text) from public;
alter table public.service_titan_endpoint_recipe_refresh_policies enable row level security;
grant select, insert, update, delete on table public.service_titan_endpoint_recipe_refresh_policies to authenticated;
comment on table public.service_titan_endpoint_recipe_refresh_policies is
  'Migration-owned allowlist of refresh intervals for each versioned ServiceTitan endpoint recipe. Binding writes are rejected unless an exact row exists.';
comment on function public.is_endpoint_recipe_refresh_allowed(text, integer, text) is
  'Returns true only for an exact recipe ID, recipe version, and refresh interval allowlisted by the database.';

do $$
begin
  if (select pg_catalog.count(*) from public.service_titan_endpoint_recipe_refresh_policies) <> 21
     or (select pg_catalog.count(distinct (endpoint_recipe_id, endpoint_recipe_version))
         from public.service_titan_endpoint_recipe_refresh_policies) <> 5 then
    raise exception 'ServiceTitan endpoint recipe refresh policy repair verification failed';
  end if;
end;
$$;

-- Internal-only configuration revisions prevent stale workers from committing results after
-- revision after the audit redaction function was defined, so scrub any historical snapshots
-- and replace the trigger function before adding browser-readable discovery state.
alter table public.audit_events disable trigger audit_events_append_only;
update public.audit_events
set before_state = case when before_state is null then null
      else before_state - array['secret_reference', 'configuration_revision'] end,
    after_state = case when after_state is null then null
      else after_state - array['secret_reference', 'configuration_revision'] end
where resource_table = 'service_titan_connections'
  and (
    coalesce(before_state ?| array['secret_reference', 'configuration_revision'], false)
    or coalesce(after_state ?| array['secret_reference', 'configuration_revision'], false)
  );
alter table public.audit_events enable trigger audit_events_append_only;

create or replace function public.audit_state_has_forbidden_credentials(
  payload jsonb,
  resource_table_name text
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  item record;
  element jsonb;
  normalized_key text;
begin
  if payload is null then return false; end if;
  if pg_catalog.jsonb_typeof(payload) = 'object' then
    for item in select key, value from pg_catalog.jsonb_each(payload)
    loop
      normalized_key := pg_catalog.lower(pg_catalog.regexp_replace(item.key, '[^a-z0-9]', '', 'g'));
      if normalized_key in ('secretreference', 'configurationrevision') then return true; end if;
      if public.audit_state_has_forbidden_credentials(item.value, resource_table_name) then return true; end if;
    end loop;
  elsif pg_catalog.jsonb_typeof(payload) = 'array' then
    for element in select value from pg_catalog.jsonb_array_elements(payload)
    loop
      if public.audit_state_has_forbidden_credentials(element, resource_table_name) then return true; end if;
    end loop;
  end if;
  return public.jsonb_has_forbidden_credential_keys(payload);
end;
$$;
revoke all on function public.audit_state_has_forbidden_credentials(jsonb, text)
  from public, anon, authenticated, service_role;

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
    (new_row ->> 'organization_id')::uuid, (old_row ->> 'organization_id')::uuid,
    (new_row ->> 'id')::uuid, (old_row ->> 'id')::uuid
  );
  if auth.role() = 'service_role'
     and current_setting('app.qa_teardown_organization_id', true) = target_organization_id::text then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  target_resource_id := coalesce((new_row ->> 'id')::uuid, (old_row ->> 'id')::uuid);
  event_action := pg_catalog.lower(tg_op);
  if tg_table_name = 'service_titan_connections' then
    old_row := case when old_row is null then null
      else old_row - array['secret_reference', 'configuration_revision'] end;
    new_row := case when new_row is null then null
      else new_row - array['secret_reference', 'configuration_revision'] end;
  end if;
  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id, before_state, after_state
  ) values (
    target_organization_id, auth.uid(), event_action, tg_table_name, target_resource_id, old_row, new_row
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.record_configuration_audit_event()
  from public, anon, authenticated, service_role;

-- ---------- ServiceTitan business-unit discovery ----------

create or replace function public.get_service_titan_connection_worker_context(
  p_organization_id uuid,
  p_connection_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_row public.service_titan_connections%rowtype;
  requested_run_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_purpose not in ('validation', 'discovery') then
    raise exception 'worker-context purpose is invalid' using errcode = '22023';
  end if;
  select * into connection_row
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived');
  if not found then raise exception 'enabled connection was not found' using errcode = 'P0002'; end if;
  select run.id into requested_run_id
  from public.service_titan_discovery_runs run
  where run.organization_id = p_organization_id and run.connection_id = p_connection_id
    and run.configuration_revision = connection_row.configuration_revision and run.status = 'requested'
  order by run.requested_at asc, run.id asc limit 1;
  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id
  ) values (
    p_organization_id, null, 'servicetitan.worker_context.' || p_purpose,
    'service_titan_connections', p_connection_id
  );
  return pg_catalog.jsonb_build_object(
    'id', connection_row.id,
    'organizationId', connection_row.organization_id,
    'serviceTitanTenantId', connection_row.service_titan_tenant_id,
    'environment', connection_row.environment,
    'secretReference', connection_row.secret_reference,
    'configurationRevision', connection_row.configuration_revision,
    'status', connection_row.status,
    'requestedDiscoveryRunId', requested_run_id
  );
end;
$$;

create or replace function public.complete_service_titan_connection_validation(
  p_organization_id uuid,
  p_connection_id uuid,
  p_configuration_revision uuid,
  p_succeeded boolean,
  p_capabilities jsonb default null,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_revision uuid;
  current_status text;
  capability jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_organization_id is null or p_connection_id is null or p_configuration_revision is null
     or p_succeeded is null then
    raise exception 'organization, connection, revision, and result are required' using errcode = '22023';
  end if;
  if p_succeeded then
    if p_error_code is not null or p_capabilities is null
       or pg_catalog.jsonb_typeof(p_capabilities) <> 'array'
       or pg_catalog.jsonb_array_length(p_capabilities) not between 1 and 50 then
      raise exception 'successful validation requires a bounded capability array and no error code' using errcode = '22023';
    end if;
    for capability in select value from pg_catalog.jsonb_array_elements(p_capabilities)
    loop
      if pg_catalog.jsonb_typeof(capability) <> 'string'
         or capability #>> '{}' !~ '^[a-z][a-z0-9._-]{0,79}$' then
        raise exception 'capability identifiers are malformed' using errcode = '22023';
      end if;
    end loop;
  elsif p_capabilities is not null
     or p_error_code is null
     or pg_catalog.length(p_error_code) not between 1 and 80
     or p_error_code !~ '^[a-z0-9][a-z0-9._-]{0,79}$' then
    raise exception 'failed validation requires only a sanitized error code' using errcode = '22023';
  end if;

  select connection.configuration_revision, connection.status
    into current_revision, current_status
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id and connection.id = p_connection_id
  for update;
  if current_revision is null or current_status in ('disabled', 'archived')
     or current_revision is distinct from p_configuration_revision then
    return false;
  end if;

  if p_succeeded then
    update public.service_titan_connections
    set status = 'ready', last_validated_at = pg_catalog.clock_timestamp(), capabilities = p_capabilities
    where organization_id = p_organization_id and id = p_connection_id;
  else
    update public.service_titan_connections
    set status = 'needs_attention', last_validated_at = null, capabilities = '[]'::jsonb
    where organization_id = p_organization_id and id = p_connection_id;
  end if;
  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id, after_state
  ) values (
    p_organization_id, null,
    case when p_succeeded then 'servicetitan.validation.succeeded' else 'servicetitan.validation.failed' end,
    'service_titan_connections', p_connection_id,
    case when p_succeeded
      then pg_catalog.jsonb_build_object('capabilities', p_capabilities)
      else pg_catalog.jsonb_build_object('errorCode', p_error_code)
    end
  );
  return true;
end;
$$;

-- ---------- ServiceTitan business-unit discovery ----------

create table public.service_titan_discovery_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  status text not null default 'requested'
    check (status in ('requested', 'running', 'completed', 'failed', 'stale')),
  requested_by uuid not null,
  configuration_revision uuid not null,
  discovery_revision uuid,
  requested_at timestamptz not null default pg_catalog.clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  constraint st_discovery_runs_connection_fk
    foreign key (organization_id, connection_id)
    references public.service_titan_connections(organization_id, id) on delete restrict,
  constraint st_discovery_runs_requester_membership_fk
    foreign key (organization_id, requested_by)
    references public.organization_memberships(organization_id, profile_id) on delete restrict,
  constraint st_discovery_runs_org_id_unique unique (organization_id, id),
  constraint st_discovery_runs_org_connection_id_unique unique (organization_id, connection_id, id),
  constraint st_discovery_runs_terminal_shape check (
    (status = 'requested' and started_at is null and completed_at is null and discovery_revision is null
      and error_code is null and error_message is null)
    or (status = 'running' and started_at is not null and completed_at is null and discovery_revision is null
      and error_code is null and error_message is null)
    or (status = 'completed' and started_at is not null and completed_at is not null and discovery_revision is not null
      and error_code is null and error_message is null)
    or (status = 'failed' and completed_at is not null and discovery_revision is null and error_code is not null)
    or (status = 'stale' and completed_at is not null and discovery_revision is null and error_code = 'stale_configuration')
  ),
  constraint st_discovery_runs_time_order check (
    (started_at is null or started_at >= requested_at)
    and (completed_at is null or completed_at >= requested_at)
  ),
  constraint st_discovery_runs_error_code_check check (
    error_code is null or (pg_catalog.length(error_code) between 1 and 80
      and error_code ~ '^[a-z0-9][a-z0-9._-]{0,79}$')
  ),
  constraint st_discovery_runs_error_message_check check (
    error_message is null or (pg_catalog.length(error_message) between 1 and 1000
      and error_message !~ '[[:cntrl:]]')
  )
);

create unique index st_discovery_runs_one_open_idx
  on public.service_titan_discovery_runs (organization_id, connection_id)
  where status in ('requested', 'running');
create index st_discovery_runs_connection_time_idx
  on public.service_titan_discovery_runs (organization_id, connection_id, requested_at desc);

comment on table public.service_titan_discovery_runs is
  'Non-secret ServiceTitan discovery ledger. configuration_revision is worker-only CAS state and is never browser-readable.';
comment on column public.service_titan_discovery_runs.error_message is
  'Sanitized non-secret provider failure summary. Never store provider payloads, request headers, tokens, or credentials.';

create table public.service_titan_business_units (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  provider_business_unit_id text not null,
  name text not null,
  active boolean not null,
  provider_modified_at timestamptz,
  discovery_revision uuid not null,
  discovery_run_id uuid not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint service_titan_business_units_pk
    primary key (organization_id, connection_id, provider_business_unit_id),
  constraint st_business_units_connection_fk
    foreign key (organization_id, connection_id)
    references public.service_titan_connections(organization_id, id) on delete restrict,
  constraint st_business_units_discovery_run_fk
    foreign key (organization_id, connection_id, discovery_run_id)
    references public.service_titan_discovery_runs(organization_id, connection_id, id) on delete restrict,
  constraint st_business_units_provider_id_check check (
    pg_catalog.length(pg_catalog.btrim(provider_business_unit_id)) between 1 and 160
    and provider_business_unit_id = pg_catalog.btrim(provider_business_unit_id)
    and provider_business_unit_id !~ '[[:cntrl:]]'
  ),
  constraint st_business_units_name_check check (
    pg_catalog.length(pg_catalog.btrim(name)) between 1 and 240 and name !~ '[[:cntrl:]]'
  )
);

create index st_business_units_active_idx
  on public.service_titan_business_units (organization_id, connection_id, active, name);

comment on table public.service_titan_business_units is
  'Normalized non-secret ServiceTitan business-unit inventory. Raw provider responses are prohibited.';

create table public.service_titan_business_unit_mappings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  location_id uuid not null,
  provider_business_unit_id text not null,
  trade text not null check (trade in ('hvac', 'plumbing', 'electrical', 'other')),
  discovery_revision uuid not null,
  discovery_run_id uuid not null,
  mapped_by uuid not null,
  mapped_at timestamptz not null default pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  constraint st_business_unit_mappings_location_fk
    foreign key (organization_id, location_id)
    references public.locations(organization_id, id) on delete restrict,
  constraint st_business_unit_mappings_unit_fk
    foreign key (organization_id, connection_id, provider_business_unit_id)
    references public.service_titan_business_units(organization_id, connection_id, provider_business_unit_id) on delete restrict,
  constraint st_business_unit_mappings_run_fk
    foreign key (organization_id, connection_id, discovery_run_id)
    references public.service_titan_discovery_runs(organization_id, connection_id, id) on delete restrict,
  constraint st_business_unit_mappings_actor_fk
    foreign key (organization_id, mapped_by)
    references public.organization_memberships(organization_id, profile_id) on delete restrict,
  constraint st_business_unit_mappings_time_order check (revoked_at is null or revoked_at >= mapped_at)
);

create unique index st_business_unit_mappings_one_active_unit_idx
  on public.service_titan_business_unit_mappings
    (organization_id, connection_id, provider_business_unit_id)
  where revoked_at is null;
create index st_business_unit_mappings_location_idx
  on public.service_titan_business_unit_mappings (organization_id, location_id, trade)
  where revoked_at is null;

comment on table public.service_titan_business_unit_mappings is
  'Revision-pinned normalized local-location to discovered ServiceTitan business-unit mapping history.';

create or replace function public.stale_service_titan_discovery_on_configuration_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.configuration_revision is distinct from old.configuration_revision then
    update public.service_titan_discovery_runs run
    set status = 'stale', completed_at = pg_catalog.clock_timestamp(),
        error_code = 'stale_configuration',
        error_message = 'Connection configuration changed before discovery completed.'
    where run.organization_id = new.organization_id
      and run.connection_id = new.id
      and run.status in ('requested', 'running');
    update public.service_titan_business_unit_mappings mapping
    set revoked_at = pg_catalog.clock_timestamp()
    where mapping.organization_id = new.organization_id
      and mapping.connection_id = new.id
      and mapping.revoked_at is null;
    update public.service_titan_business_units unit
    set active = false, updated_at = pg_catalog.clock_timestamp()
    where unit.organization_id = new.organization_id
      and unit.connection_id = new.id
      and unit.active;
  end if;
  return new;
end;
$$;
revoke all on function public.stale_service_titan_discovery_on_configuration_change()
  from public, anon, authenticated, service_role;

create trigger service_titan_connections_stale_discovery
before update of configuration_revision on public.service_titan_connections
for each row execute function public.stale_service_titan_discovery_on_configuration_change();

create or replace function public.request_service_titan_business_unit_discovery(
  p_organization_id uuid,
  p_connection_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  current_revision uuid;
  run_id uuid;
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

  select connection.configuration_revision into current_revision
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status = 'ready'
    and connection.last_validated_at is not null
  for update;
  if current_revision is null then
    raise exception 'validated ServiceTitan connection was not found' using errcode = 'P0002';
  end if;

  select run.id into run_id
  from public.service_titan_discovery_runs run
  where run.organization_id = p_organization_id
    and run.connection_id = p_connection_id
    and run.configuration_revision = current_revision
    and run.status in ('requested', 'running')
  order by run.requested_at desc
  limit 1;
  if run_id is not null then
    return run_id;
  end if;

  insert into public.service_titan_discovery_runs (
    organization_id, connection_id, requested_by, configuration_revision
  ) values (
    p_organization_id, p_connection_id, auth.uid(), current_revision
  ) returning id into run_id;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'servicetitan.discovery.request',
    'service_titan_discovery_runs', run_id, null,
    pg_catalog.jsonb_build_object('status', 'requested', 'connectionId', p_connection_id),
    pg_catalog.current_setting('request.id', true)
  );
  return run_id;
end;
$$;

create or replace function public.start_service_titan_business_unit_discovery(
  p_organization_id uuid,
  p_connection_id uuid,
  p_discovery_run_id uuid,
  p_configuration_revision uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_revision uuid;
  run_revision uuid;
  run_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_configuration_revision is null then
    raise exception 'configuration revision is required' using errcode = '22023';
  end if;
  select connection.configuration_revision into current_revision
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id and connection.id = p_connection_id
    and connection.status = 'ready'
    and connection.last_validated_at is not null
  for update;
  select run.configuration_revision, run.status into run_revision, run_status
  from public.service_titan_discovery_runs run
  where run.organization_id = p_organization_id and run.connection_id = p_connection_id
    and run.id = p_discovery_run_id
  for update;
  if run_status is null then
    raise exception 'discovery run was not found' using errcode = 'P0002';
  end if;
  if current_revision is null or current_revision is distinct from p_configuration_revision
     or run_revision is distinct from p_configuration_revision then
    if run_status in ('requested', 'running') then
      update public.service_titan_discovery_runs
      set status = 'stale', completed_at = pg_catalog.clock_timestamp(),
          error_code = 'stale_configuration',
          error_message = 'Connection configuration changed before discovery started.'
      where organization_id = p_organization_id and id = p_discovery_run_id;
    end if;
    return false;
  end if;
  if run_status = 'running' then return true; end if;
  if run_status <> 'requested' then return false; end if;
  update public.service_titan_discovery_runs
  set status = 'running', started_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and id = p_discovery_run_id;
  return true;
end;
$$;

create or replace function public.complete_service_titan_business_unit_discovery(
  p_organization_id uuid,
  p_connection_id uuid,
  p_discovery_run_id uuid,
  p_configuration_revision uuid,
  p_inventory jsonb,
  p_error_code text default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_revision uuid;
  run_revision uuid;
  run_status text;
  new_discovery_revision uuid := extensions.gen_random_uuid();
  inventory_item jsonb;
  provider_id text;
  unit_name text;
  unit_active boolean;
  provider_modified timestamptz;
  inventory_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_configuration_revision is null then
    raise exception 'configuration revision is required' using errcode = '22023';
  end if;

  select connection.configuration_revision into current_revision
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id and connection.id = p_connection_id
    and connection.status = 'ready'
    and connection.last_validated_at is not null
  for update;
  select run.configuration_revision, run.status into run_revision, run_status
  from public.service_titan_discovery_runs run
  where run.organization_id = p_organization_id and run.connection_id = p_connection_id
    and run.id = p_discovery_run_id
  for update;
  if run_status is null then
    raise exception 'discovery run was not found' using errcode = 'P0002';
  end if;
  if current_revision is null or current_revision is distinct from p_configuration_revision
     or run_revision is distinct from p_configuration_revision then
    if run_status in ('requested', 'running') then
      update public.service_titan_discovery_runs
      set status = 'stale', completed_at = pg_catalog.clock_timestamp(),
          error_code = 'stale_configuration',
          error_message = 'Connection configuration changed before discovery completed.'
      where organization_id = p_organization_id and id = p_discovery_run_id;
    end if;
    return false;
  end if;
  if run_status not in ('requested', 'running') then return false; end if;

  if p_error_code is not null then
    if p_inventory is not null
       or pg_catalog.length(p_error_code) not between 1 and 80
       or p_error_code !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
       or p_error_code = 'stale_configuration' then
      raise exception 'non-secret discovery failure code is invalid' using errcode = '22023';
    end if;
    update public.service_titan_discovery_runs
    set status = 'failed', started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
        completed_at = pg_catalog.clock_timestamp(), error_code = p_error_code,
        error_message = 'ServiceTitan discovery failed. Review trusted worker diagnostics using error code ' || p_error_code || '.'
    where organization_id = p_organization_id and id = p_discovery_run_id;
    insert into public.audit_events (
      organization_id, actor_profile_id, action, resource_table, resource_id,
      before_state, after_state, request_id
    ) values (
      p_organization_id, null, 'servicetitan.discovery.failed',
      'service_titan_discovery_runs', p_discovery_run_id, null,
      pg_catalog.jsonb_build_object('status', 'failed', 'errorCode', p_error_code),
      pg_catalog.current_setting('request.id', true)
    );
    return true;
  end if;

  if p_error_message is not null or p_inventory is null
     or pg_catalog.jsonb_typeof(p_inventory) <> 'array'
     or pg_catalog.jsonb_array_length(p_inventory) > 10000
     or public.jsonb_has_forbidden_credential_keys(p_inventory) then
    raise exception 'complete normalized business-unit inventory is invalid' using errcode = '22023';
  end if;
  inventory_count := pg_catalog.jsonb_array_length(p_inventory);
  if (select pg_catalog.count(distinct value ->> 'providerBusinessUnitId')
      from pg_catalog.jsonb_array_elements(p_inventory)) <> inventory_count then
    raise exception 'business-unit inventory contains duplicate provider IDs' using errcode = '22023';
  end if;

  for inventory_item in select value from pg_catalog.jsonb_array_elements(p_inventory)
  loop
    if pg_catalog.jsonb_typeof(inventory_item) <> 'object'
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(inventory_item) key
         where key not in ('providerBusinessUnitId', 'name', 'active', 'providerModifiedAt')
       )
       or not (inventory_item ?& array['providerBusinessUnitId', 'name', 'active'])
       or pg_catalog.jsonb_typeof(inventory_item -> 'providerBusinessUnitId') <> 'string'
       or pg_catalog.jsonb_typeof(inventory_item -> 'name') <> 'string'
       or pg_catalog.jsonb_typeof(inventory_item -> 'active') <> 'boolean'
       or (inventory_item ? 'providerModifiedAt'
           and pg_catalog.jsonb_typeof(inventory_item -> 'providerModifiedAt') <> 'string') then
      raise exception 'business-unit inventory item shape is invalid' using errcode = '22023';
    end if;
    provider_id := inventory_item ->> 'providerBusinessUnitId';
    unit_name := inventory_item ->> 'name';
    if provider_id is null or provider_id <> pg_catalog.btrim(provider_id)
       or pg_catalog.length(provider_id) not between 1 and 160 or provider_id ~ '[[:cntrl:]]'
       or unit_name is null or pg_catalog.length(pg_catalog.btrim(unit_name)) not between 1 and 240
       or unit_name ~ '[[:cntrl:]]' then
      raise exception 'business-unit identity is invalid' using errcode = '22023';
    end if;
    if inventory_item ? 'providerModifiedAt' then
      begin
        provider_modified := (inventory_item ->> 'providerModifiedAt')::timestamptz;
      exception when others then
        raise exception 'provider modified timestamp is invalid' using errcode = '22023';
      end;
    else
      provider_modified := null;
    end if;
  end loop;

  -- Preserve normalized identities for historical mappings, but make the complete current
  -- snapshot authoritative by deactivating units omitted from this paginated result.
  update public.service_titan_business_units
  set active = false, discovery_revision = new_discovery_revision,
      discovery_run_id = p_discovery_run_id, updated_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and connection_id = p_connection_id;

  for inventory_item in select value from pg_catalog.jsonb_array_elements(p_inventory)
  loop
    provider_id := inventory_item ->> 'providerBusinessUnitId';
    unit_name := inventory_item ->> 'name';
    unit_active := (inventory_item ->> 'active')::boolean;
    provider_modified := case when inventory_item ? 'providerModifiedAt'
      then (inventory_item ->> 'providerModifiedAt')::timestamptz else null end;
    insert into public.service_titan_business_units (
      organization_id, connection_id, provider_business_unit_id, name, active,
      provider_modified_at, discovery_revision, discovery_run_id, last_seen_at
    ) values (
      p_organization_id, p_connection_id, provider_id, pg_catalog.btrim(unit_name), unit_active,
      provider_modified, new_discovery_revision, p_discovery_run_id, pg_catalog.clock_timestamp()
    )
    on conflict (organization_id, connection_id, provider_business_unit_id) do update
    set name = excluded.name, active = excluded.active,
        provider_modified_at = excluded.provider_modified_at,
        discovery_revision = excluded.discovery_revision,
        discovery_run_id = excluded.discovery_run_id,
        last_seen_at = excluded.last_seen_at,
        updated_at = pg_catalog.clock_timestamp();
  end loop;

  update public.service_titan_discovery_runs
  set status = 'completed', started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
      completed_at = pg_catalog.clock_timestamp(), discovery_revision = new_discovery_revision,
      error_code = null, error_message = null
  where organization_id = p_organization_id and id = p_discovery_run_id;
  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, null, 'servicetitan.discovery.complete',
    'service_titan_discovery_runs', p_discovery_run_id, null,
    pg_catalog.jsonb_build_object('status', 'completed', 'businessUnitCount', inventory_count,
      'discoveryRevision', new_discovery_revision),
    pg_catalog.current_setting('request.id', true)
  );
  return true;
end;
$$;

create or replace function public.replace_service_titan_connection_locations(
  p_organization_id uuid,
  p_connection_id uuid,
  p_location_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  requested_count integer;
  v_location_id uuid;
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
  if p_location_ids is null or pg_catalog.array_position(p_location_ids, null) is not null then
    raise exception 'location assignment selection must be a non-null UUID array' using errcode = '22023';
  end if;
  requested_count := pg_catalog.cardinality(p_location_ids);
  if (select pg_catalog.count(distinct selected_id)
      from pg_catalog.unnest(p_location_ids) selected_id) <> requested_count then
    raise exception 'location assignment selection contains duplicates' using errcode = '22023';
  end if;
  perform 1 from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status not in ('disabled', 'archived')
  for update;
  if not found then
    raise exception 'enabled ServiceTitan connection was not found' using errcode = 'P0002';
  end if;
  if (select pg_catalog.count(*) from public.locations location
      where location.organization_id = p_organization_id
        and location.status = 'active'
        and location.id = any (p_location_ids)) <> requested_count then
    raise exception 'every assigned location must be active in this organization' using errcode = '22023';
  end if;

  update public.service_titan_connection_locations assignment
  set revoked_at = pg_catalog.clock_timestamp()
  where assignment.organization_id = p_organization_id
    and assignment.connection_id = p_connection_id
    and assignment.revoked_at is null
    and not (assignment.location_id = any (p_location_ids));

  update public.service_titan_business_unit_mappings mapping
  set revoked_at = pg_catalog.clock_timestamp()
  where mapping.organization_id = p_organization_id
    and mapping.connection_id = p_connection_id
    and mapping.revoked_at is null
    and not (mapping.location_id = any (p_location_ids));

  foreach v_location_id in array p_location_ids
  loop
    if not exists (
      select 1 from public.service_titan_connection_locations assignment
      where assignment.organization_id = p_organization_id
        and assignment.connection_id = p_connection_id
        and assignment.location_id = v_location_id
        and assignment.revoked_at is null
    ) then
      insert into public.service_titan_connection_locations (
        organization_id, connection_id, location_id
      ) values (p_organization_id, p_connection_id, v_location_id);
    end if;
  end loop;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'servicetitan.connection_locations.replace',
    'service_titan_connection_locations', p_connection_id, null,
    pg_catalog.jsonb_build_object('connectionId', p_connection_id, 'activeLocationCount', requested_count),
    pg_catalog.current_setting('request.id', true)
  );
  return requested_count;
end;
$$;

create or replace function public.replace_service_titan_business_unit_mappings(
  p_organization_id uuid,
  p_connection_id uuid,
  p_discovery_revision uuid,
  p_mappings jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  current_run_id uuid;
  current_revision uuid;
  connection_revision uuid;
  mapping_item jsonb;
  mapped_location_id uuid;
  provider_id text;
  mapped_trade text;
  mapping_count integer;
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
  if p_discovery_revision is null or p_mappings is null
     or pg_catalog.jsonb_typeof(p_mappings) <> 'array'
     or pg_catalog.jsonb_array_length(p_mappings) > 10000
     or public.jsonb_has_forbidden_credential_keys(p_mappings) then
    raise exception 'mapping revision and normalized mapping array are required' using errcode = '22023';
  end if;

  select connection.configuration_revision into connection_revision
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status = 'ready'
    and connection.last_validated_at is not null
  for update;
  if connection_revision is null then
    raise exception 'validated ServiceTitan connection was not found' using errcode = 'P0002';
  end if;

  select run.id, run.discovery_revision into current_run_id, current_revision
  from public.service_titan_discovery_runs run
  where run.organization_id = p_organization_id and run.connection_id = p_connection_id
    and run.status = 'completed'
    and run.configuration_revision = connection_revision
  order by run.completed_at desc, run.requested_at desc
  limit 1
  for share;
  if current_revision is null or current_revision is distinct from p_discovery_revision then
    raise exception 'business-unit discovery revision is stale' using errcode = '40001';
  end if;
  mapping_count := pg_catalog.jsonb_array_length(p_mappings);
  if (select pg_catalog.count(distinct value ->> 'providerBusinessUnitId')
      from pg_catalog.jsonb_array_elements(p_mappings)) <> mapping_count then
    raise exception 'one provider business unit cannot map to multiple active locations' using errcode = '23505';
  end if;

  for mapping_item in select value from pg_catalog.jsonb_array_elements(p_mappings)
  loop
    if pg_catalog.jsonb_typeof(mapping_item) <> 'object'
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(mapping_item) key
         where key not in ('locationId', 'providerBusinessUnitId', 'trade')
       )
       or not (mapping_item ?& array['locationId', 'providerBusinessUnitId', 'trade'])
       or pg_catalog.jsonb_typeof(mapping_item -> 'locationId') <> 'string'
       or pg_catalog.jsonb_typeof(mapping_item -> 'providerBusinessUnitId') <> 'string'
       or pg_catalog.jsonb_typeof(mapping_item -> 'trade') <> 'string'
       or (mapping_item ->> 'locationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or (mapping_item ->> 'trade') not in ('hvac', 'plumbing', 'electrical', 'other') then
      raise exception 'business-unit mapping item shape is invalid' using errcode = '22023';
    end if;
    mapped_location_id := (mapping_item ->> 'locationId')::uuid;
    provider_id := mapping_item ->> 'providerBusinessUnitId';
    mapped_trade := mapping_item ->> 'trade';
    if not exists (
      select 1 from public.locations location
      where location.organization_id = p_organization_id
        and location.id = mapped_location_id and location.status = 'active'
    ) then
      raise exception 'mapping location is not active in this organization' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.service_titan_connection_locations assignment
      where assignment.organization_id = p_organization_id
        and assignment.connection_id = p_connection_id
        and assignment.location_id = mapped_location_id
        and assignment.revoked_at is null
    ) then
      raise exception 'mapping location is not actively assigned to this connection' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.service_titan_business_units unit
      where unit.organization_id = p_organization_id and unit.connection_id = p_connection_id
        and unit.provider_business_unit_id = provider_id and unit.active
        and unit.discovery_revision = p_discovery_revision
        and unit.discovery_run_id = current_run_id
    ) then
      raise exception 'mapping business unit is not active in the current discovery revision' using errcode = '22023';
    end if;
  end loop;

  update public.service_titan_business_unit_mappings
  set revoked_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and connection_id = p_connection_id
    and revoked_at is null;
  for mapping_item in select value from pg_catalog.jsonb_array_elements(p_mappings)
  loop
    insert into public.service_titan_business_unit_mappings (
      organization_id, connection_id, location_id, provider_business_unit_id,
      trade, discovery_revision, discovery_run_id, mapped_by
    ) values (
      p_organization_id, p_connection_id, (mapping_item ->> 'locationId')::uuid,
      mapping_item ->> 'providerBusinessUnitId', mapping_item ->> 'trade',
      p_discovery_revision, current_run_id, auth.uid()
    );
  end loop;
  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'servicetitan.business_unit_mappings.replace',
    'service_titan_business_unit_mappings', p_connection_id, null,
    pg_catalog.jsonb_build_object('connectionId', p_connection_id,
      'discoveryRevision', p_discovery_revision, 'activeMappingCount', mapping_count),
    pg_catalog.current_setting('request.id', true)
  );
  return mapping_count;
end;
$$;

-- ---------- Application-owned original KPI catalog ----------

create table public.original_kpi_catalog (
  kpi_key text not null,
  catalog_version integer not null check (catalog_version > 0),
  title text not null,
  section text not null check (section in ('executive', 'revenue', 'calls', 'appointments', 'sales', 'membership')),
  value_kind text not null check (value_kind in ('currency', 'number', 'percent', 'ratio')),
  direction text not null check (direction in ('higher', 'lower', 'informational')),
  subtitle text not null,
  source_system text not null check (source_system in ('ServiceTitan', 'Derived', 'Budget', 'Call System', 'GA4', 'Custom')),
  source_readiness_requirement text not null check (source_readiness_requirement in (
    'service_titan_connection', 'service_titan_business_unit_mapping', 'derived_inputs',
    'budget_inputs', 'call_system_connection', 'ga4_connection', 'custom_integration'
  )),
  endpoint_recipe_id text,
  endpoint_recipe_version integer,
  default_refresh_cadence text not null check (default_refresh_cadence in ('15m', '30m', '1h', '4h', '12h', '24h', 'daily', 'weekly', 'monthly')),
  default_stale_after_hours numeric not null,
  default_warning_attainment numeric not null,
  default_critical_attainment numeric not null,
  playbook jsonb not null default '[]'::jsonb,
  presentation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint original_kpi_catalog_pk primary key (kpi_key, catalog_version),
  constraint original_kpi_catalog_key_format check (kpi_key ~ '^[a-z0-9][a-z0-9-]{2,54}$'),
  constraint original_kpi_catalog_text_check check (
    pg_catalog.btrim(title) <> '' and pg_catalog.btrim(subtitle) <> ''
  ),
  constraint original_kpi_catalog_recipe_shape check (
    (endpoint_recipe_id is null and endpoint_recipe_version is null)
    or (endpoint_recipe_id is not null and pg_catalog.btrim(endpoint_recipe_id) <> ''
      and endpoint_recipe_version is not null and endpoint_recipe_version > 0)
  ),
  constraint original_kpi_catalog_thresholds check (
    public.is_finite_numeric(default_stale_after_hours) and default_stale_after_hours > 0
    and public.is_finite_numeric(default_warning_attainment)
    and public.is_finite_numeric(default_critical_attainment)
    and default_critical_attainment between 0 and 100
    and default_warning_attainment between 0 and 100
    and default_critical_attainment < default_warning_attainment
  ),
  constraint original_kpi_catalog_json_shapes check (
    pg_catalog.jsonb_typeof(playbook) = 'array' and pg_catalog.jsonb_typeof(presentation) = 'object'
  ),
  constraint original_kpi_catalog_json_no_credentials check (
    not public.jsonb_has_forbidden_credential_keys(playbook)
    and not public.jsonb_has_forbidden_credential_keys(presentation)
  )
);

comment on table public.original_kpi_catalog is
  'Migration-owned versioned production catalog for the exact 36 original board KPIs; it contains definitions and presentation only, never observations or targets.';

insert into public.original_kpi_catalog (
  kpi_key, catalog_version, title, section, value_kind, direction, subtitle,
  source_system, source_readiness_requirement, endpoint_recipe_id, endpoint_recipe_version,
  default_refresh_cadence, default_stale_after_hours, default_warning_attainment,
  default_critical_attainment, playbook, presentation
) values
('revenue-mtd',1,'Revenue MTD','executive','currency','higher','Month-to-date actual versus published revenue budget','ServiceTitan','service_titan_connection','completed-revenue',1,'1h',4,100,90,'[{"title":"Daily revenue huddle","detail":"Review prior-day actuals, remaining gap, and capacity by trade."},{"title":"Recover the largest division gap","detail":"Assign one owner to volume, conversion, and average ticket actions."}]','{}'),
('pace',1,'Projected Month-End','executive','currency','higher','Projected month-end revenue versus published budget','Derived','derived_inputs',null,null,'1h',4,95,90,'[{"title":"Protect scheduled revenue","detail":"Review cancellations, open capacity, and sold work not yet completed."},{"title":"Close the final gap","detail":"Translate the forecast gap into jobs per remaining workday."}]','{}'),
('ebitda',1,'Gross Margin','executive','percent','higher','Gross margin versus the published operating target','Budget','budget_inputs',null,null,'daily',48,96,90,'[{"title":"Audit discounting","detail":"Review jobs with the highest discount-to-revenue ratio."},{"title":"Inspect labor efficiency","detail":"Separate pricing leakage from labor and material variance."}]','{}'),
('booking-rate',1,'Call Booking Rate','executive','percent','higher','Booked inbound opportunities divided by qualified inbound calls','ServiceTitan','service_titan_connection','inbound-call-booking-rate',1,'1h',4,95,90,'[{"title":"Listen to unbooked calls","detail":"Review ten high-intent calls by reason and CSR."},{"title":"Protect same-day capacity","detail":"Make open appointment slots visible to the booking team."}]','{}'),
('sales-close',1,'Sales Close Rate','executive','percent','higher','Sold opportunities divided by qualified sales opportunities','ServiceTitan','service_titan_connection','sales-close-rate',1,'1h',4,100,90,'[{"title":"Coach by lead type","detail":"Separate Tech Lead, NCE, and Team Visit close rates."},{"title":"48-hour follow-up","detail":"Assign every unsold opportunity an owner and due date."}]','{}'),
('avg-ticket',1,'Service Avg Ticket','executive','currency','higher','Average completed service revenue per invoice','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[{"title":"Recognize the right behavior","detail":"Share compliant jobs where options improved customer value."},{"title":"Protect quality","detail":"Monitor recalls and discounts alongside average ticket."}]','{}'),
('membership-net',1,'Membership Net Growth','executive','number','higher','New memberships less cancellations and expirations','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[{"title":"Launch cancellation saves","detail":"Route cancellation requests to a trained save specialist."},{"title":"Fix the top cancellation reason","detail":"Segment price, service, move, and payment failures."}]','{}'),
('open-capacity',1,'Open Capacity · Next 3 Days','executive','number','lower','Available technician appointment capacity across the next three days','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[{"title":"Fill tomorrow first","detail":"Prioritize outbound and reschedules against near-term openings."},{"title":"Align marketing spend","detail":"Shift demand generation toward the trades with capacity."}]','{}'),
('hvac-revenue',1,'HVAC Revenue','revenue','currency','higher','Mapped HVAC month-to-date revenue versus budget','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('plumbing-revenue',1,'Plumbing Revenue','revenue','currency','higher','Mapped plumbing month-to-date revenue versus budget','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('electrical-revenue',1,'Electrical Revenue','revenue','currency','higher','Mapped electrical month-to-date revenue versus budget','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('ytd-revenue',1,'Revenue YTD','revenue','currency','higher','Year-to-date actual revenue versus published budget','ServiceTitan','service_titan_connection',null,null,'4h',24,98,90,'[]','{}'),
('pipeline',1,'Committed Pipeline','revenue','currency','higher','Won estimates not yet recognized as completed revenue','Derived','derived_inputs',null,null,'1h',4,100,90,'[]','{}'),
('annual-forecast',1,'Annual Forecast','revenue','currency','higher','Projected full-year revenue versus published annual budget','Derived','derived_inputs',null,null,'daily',48,100,90,'[]','{}'),
('inbound-calls',1,'Inbound Calls','calls','number','higher','Qualified inbound demand across configured call sources','Call System','call_system_connection',null,null,'1h',4,100,90,'[]','{}'),
('calls-booked',1,'Calls Booked','calls','number','higher','Qualified inbound calls converted to appointments','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[]','{}'),
('calls-not-booked',1,'Not Booked','calls','number','lower','Qualified inbound calls not converted to appointments','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[]','{}'),
('digital-visits',1,'Digital Visits','calls','number','higher','Qualified website visits from the configured analytics source','GA4','ga4_connection',null,null,'4h',12,100,90,'[]','{}'),
('digital-bookings',1,'Digital Bookings','calls','number','higher','Qualified booking events from forms, schedulers, and chat','Custom','custom_integration',null,null,'1h',4,100,90,'[]','{}'),
('digital-conversion',1,'Digital Conversion','calls','percent','higher','Qualified digital bookings divided by qualified digital visits','Derived','derived_inputs',null,null,'1h',4,100,90,'[]','{}'),
('hvac-service-appts',1,'HVAC Service Appointments','appointments','number','higher','Mapped HVAC service appointments versus target','ServiceTitan','service_titan_business_unit_mapping','completed-appointments',1,'1h',4,100,90,'[]','{}'),
('plumbing-appts',1,'Plumbing Appointments','appointments','number','higher','Mapped plumbing appointments versus target','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('hvac-sales-appts',1,'HVAC Sales Opportunities','appointments','number','higher','Mapped HVAC sales opportunities versus target','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,95,90,'[]','{}'),
('old-equipment',1,'10+ Year Equipment Calls','appointments','number','higher','Qualified calls involving equipment at least ten years old','ServiceTitan','service_titan_connection',null,null,'4h',12,100,90,'[]','{}'),
('capacity-util',1,'Capacity Utilization','appointments','percent','higher','Booked technician hours divided by available technician hours','Derived','derived_inputs',null,null,'1h',4,100,90,'[]','{}'),
('hvac-close',1,'HVAC Close Rate','sales','percent','higher','Sold mapped HVAC opportunities divided by qualified opportunities','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('hvac-maintenance-close',1,'HVAC Maintenance Close Rate','sales','percent','higher','Sold qualified HVAC maintenance opportunities divided by qualified opportunities','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('plumbing-close',1,'Plumbing Close Rate','sales','percent','higher','Sold mapped plumbing opportunities divided by qualified opportunities','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('hvac-ticket',1,'HVAC Sold Avg Ticket','sales','currency','higher','Average sold revenue across qualified HVAC replacement opportunities','ServiceTitan','service_titan_business_unit_mapping',null,null,'1h',4,100,90,'[]','{}'),
('revenue-per-opportunity',1,'Revenue per Opportunity','sales','currency','higher','Sold revenue divided by all qualified opportunities','Derived','derived_inputs',null,null,'1h',4,100,90,'[]','{}'),
('unsold-followup',1,'Unsold Follow-Up Compliance','sales','percent','higher','Unsold opportunities receiving the required follow-up activity','Custom','custom_integration',null,null,'1h',4,100,90,'[]','{}'),
('active-members',1,'Active Members','membership','number','higher','Active recurring memberships at the period end','ServiceTitan','service_titan_connection','active-memberships',1,'1h',4,98,90,'[]','{}'),
('new-members',1,'New Memberships','membership','number','higher','New memberships sold during the selected period','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[]','{}'),
('member-cancels',1,'Cancellations + Expirations','membership','number','lower','Membership cancellations, expirations, and failed renewals','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[]','{}'),
('club-conversion',1,'Club Conversion','membership','percent','higher','New memberships divided by eligible membership opportunities','ServiceTitan','service_titan_connection',null,null,'1h',4,100,90,'[]','{}'),
('recurring-revenue',1,'Monthly Recurring Revenue','membership','currency','higher','Normalized monthly recurring revenue from active agreements','Derived','derived_inputs',null,null,'1h',4,95,90,'[]','{}');

do $$
begin
  if (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) <> 36
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'executive') <> 8
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'revenue') <> 6
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'calls') <> 6
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'appointments') <> 5
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'sales') <> 6
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'membership') <> 5
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and endpoint_recipe_id is not null) <> 5
     or (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1 and section = 'executive'
          and pg_catalog.jsonb_array_length(playbook) = 2) <> 8
     or exists (
       select 1 from public.original_kpi_catalog catalog
       where catalog.catalog_version = 1
         and (
           catalog.default_critical_attainment <> 90
           or catalog.default_warning_attainment <> case catalog.kpi_key
             when 'pace' then 95 when 'ebitda' then 96 when 'booking-rate' then 95
             when 'ytd-revenue' then 98 when 'hvac-sales-appts' then 95
             when 'active-members' then 98 when 'recurring-revenue' then 95
             else 100 end
           or catalog.subtitle ~ '[$%0-9]'
         )
     )
     or exists (
       select 1 from public.original_kpi_catalog catalog
       where catalog.endpoint_recipe_id is not null and not exists (
         select 1 from public.service_titan_endpoint_recipe_refresh_policies policy
         where policy.endpoint_recipe_id = catalog.endpoint_recipe_id
           and policy.endpoint_recipe_version = catalog.endpoint_recipe_version
       )
     ) then
    raise exception 'exact original KPI catalog seed verification failed';
  end if;
end;
$$;

create or replace function public.enable_original_kpi_catalog(
  p_organization_id uuid,
  p_kpi_keys text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  inserted_count integer;
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
  if p_kpi_keys is null or pg_catalog.array_position(p_kpi_keys, null) is not null then
    raise exception 'KPI key selection must be a non-null text array' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(p_kpi_keys) selected_key
    where not exists (
      select 1 from public.original_kpi_catalog catalog
      where catalog.catalog_version = 1 and catalog.kpi_key = selected_key
    )
  ) then
    raise exception 'KPI key selection contains an unknown original catalog key' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.custom_kpi_definitions existing
    join public.original_kpi_catalog catalog
      on catalog.catalog_version = 1 and catalog.kpi_key = existing.kpi_key
    where existing.organization_id = p_organization_id
      and (pg_catalog.cardinality(p_kpi_keys) = 0 or existing.kpi_key = any (p_kpi_keys))
      and (
        existing.version is distinct from catalog.catalog_version
        or existing.lifecycle is distinct from 'published'
        or existing.title is distinct from catalog.title
        or existing.section is distinct from catalog.section
        or existing.value_kind is distinct from catalog.value_kind
        or existing.direction is distinct from catalog.direction
        or existing.external_source ->> 'catalogName' is distinct from 'original'
        or existing.external_source ->> 'catalogVersion' is distinct from catalog.catalog_version::text
      )
  ) then
    raise exception 'an existing KPI key conflicts with the original catalog; resolve it before enablement'
      using errcode = '23505';
  end if;

  insert into public.custom_kpi_definitions (
    organization_id, kpi_key, version, type, lifecycle, title, business_definition,
    owner_profile_id, section, value_kind, direction, subtitle, scope_mode, viewer_roles,
    formula, external_source, refresh_cadence, stale_after_hours, release_note,
    validation_results, validated_at, published_at
  )
  select
    p_organization_id, catalog.kpi_key, catalog.catalog_version,
    case catalog.source_system
      when 'ServiceTitan' then 'service_titan'
      when 'Derived' then 'derived'
      when 'Budget' then 'manual'
      else 'external'
    end,
    'published', catalog.title,
    catalog.title || ': ' || catalog.subtitle,
    auth.uid(), catalog.section, catalog.value_kind, catalog.direction, catalog.subtitle,
    'selected_locations',
    '["owner","admin","brand_executive","general_manager","department_leader","viewer"]'::jsonb,
    case when catalog.source_system = 'Derived'
      then pg_catalog.jsonb_build_object('catalogManaged', true) else '{}'::jsonb end,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'catalogName', 'original', 'catalogVersion', catalog.catalog_version,
      'sourceSystem', catalog.source_system,
      'sourceReadinessRequirement', catalog.source_readiness_requirement,
      'endpointRecipeId', catalog.endpoint_recipe_id,
      'endpointRecipeVersion', catalog.endpoint_recipe_version,
      'defaultWarningAttainment', catalog.default_warning_attainment,
      'defaultCriticalAttainment', catalog.default_critical_attainment,
      'playbook', catalog.playbook, 'presentation', catalog.presentation
    )),
    catalog.default_refresh_cadence, catalog.default_stale_after_hours,
    'Original KPI catalog v1 · 20260819001500_servicetitan_discovery_kpi_catalog',
    '[{"status":"pass","check":"migration-owned original KPI catalog v1"}]'::jsonb,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  from public.original_kpi_catalog catalog
  where catalog.catalog_version = 1
    and (pg_catalog.cardinality(p_kpi_keys) = 0 or catalog.kpi_key = any (p_kpi_keys))
    and not exists (
      select 1 from public.custom_kpi_definitions existing
      where existing.organization_id = p_organization_id and existing.kpi_key = catalog.kpi_key
    )
  order by catalog.section, catalog.kpi_key
  on conflict (organization_id, kpi_key, version) do nothing;
  get diagnostics inserted_count = row_count;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'original_kpi_catalog.enable',
    'custom_kpi_definitions', null, null,
    pg_catalog.jsonb_build_object('catalogVersion', 1, 'insertedCount', inserted_count,
      'requestedAll', pg_catalog.cardinality(p_kpi_keys) = 0),
    pg_catalog.current_setting('request.id', true)
  );
  return inserted_count;
end;
$$;

-- ---------- RLS, ACLs, and explicit RPC surface ----------

alter table public.service_titan_discovery_runs enable row level security;
alter table public.service_titan_business_units enable row level security;
alter table public.service_titan_business_unit_mappings enable row level security;
alter table public.original_kpi_catalog enable row level security;

create policy st_discovery_runs_admin_read on public.service_titan_discovery_runs
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_business_units_admin_read on public.service_titan_business_units
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_business_unit_mappings_admin_read on public.service_titan_business_unit_mappings
for select to authenticated
using (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy original_kpi_catalog_authenticated_read on public.original_kpi_catalog
for select to authenticated using (true);

revoke all on table public.service_titan_discovery_runs from public, anon, authenticated;
grant select (
  id, organization_id, connection_id, status, requested_by, discovery_revision,
  requested_at, started_at, completed_at, error_code, error_message
) on public.service_titan_discovery_runs to authenticated;
revoke all on table public.service_titan_business_units from public, anon, authenticated;
grant select on table public.service_titan_business_units to authenticated;
revoke all on table public.service_titan_business_unit_mappings from public, anon, authenticated;
grant select on table public.service_titan_business_unit_mappings to authenticated;
revoke all on table public.original_kpi_catalog from public, anon, authenticated;
grant select on table public.original_kpi_catalog to authenticated;

revoke all on function public.get_service_titan_connection_worker_context(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_service_titan_connection_worker_context(uuid, uuid, text)
  to service_role;
revoke all on function public.complete_service_titan_connection_validation(uuid, uuid, uuid, boolean, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_service_titan_connection_validation(uuid, uuid, uuid, boolean, jsonb, text)
  to service_role;
revoke all on function public.request_service_titan_business_unit_discovery(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.request_service_titan_business_unit_discovery(uuid, uuid)
  to authenticated;
revoke all on function public.start_service_titan_business_unit_discovery(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.start_service_titan_business_unit_discovery(uuid, uuid, uuid, uuid)
  to service_role;
revoke all on function public.complete_service_titan_business_unit_discovery(uuid, uuid, uuid, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_service_titan_business_unit_discovery(uuid, uuid, uuid, uuid, jsonb, text, text)
  to service_role;
revoke all on function public.replace_service_titan_connection_locations(uuid, uuid, uuid[])
  from public, anon, service_role;
grant execute on function public.replace_service_titan_connection_locations(uuid, uuid, uuid[])
  to authenticated;
revoke all on function public.replace_service_titan_business_unit_mappings(uuid, uuid, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.replace_service_titan_business_unit_mappings(uuid, uuid, uuid, jsonb)
  to authenticated;
revoke all on function public.enable_original_kpi_catalog(uuid, text[])
  from public, anon, service_role;
grant execute on function public.enable_original_kpi_catalog(uuid, text[])
  to authenticated;

comment on function public.get_service_titan_connection_worker_context(uuid, uuid, text) is
  'Service-role-only audited connection metadata lookup; returns no credential values and optionally identifies the current requested discovery run.';
comment on function public.complete_service_titan_connection_validation(uuid, uuid, uuid, boolean, jsonb, text) is
  'Service-role-only compare-and-set validation completion; stores capabilities or a sanitized error code without provider diagnostics.';
comment on function public.request_service_titan_business_unit_discovery(uuid, uuid) is
  'Idempotently queues discovery for the exact current connection configuration without exposing its revision.';
comment on function public.complete_service_titan_business_unit_discovery(uuid, uuid, uuid, uuid, jsonb, text, text) is
  'Service-role-only transactional replacement/upsert of a complete normalized paginated business-unit inventory with configuration CAS; raw worker diagnostics are never persisted.';
comment on function public.replace_service_titan_connection_locations(uuid, uuid, uuid[]) is
  'Owner/admin atomic replacement of active locations assigned to one ServiceTitan connection; removed locations also revoke their business-unit mappings.';
comment on function public.replace_service_titan_business_unit_mappings(uuid, uuid, uuid, jsonb) is
  'Owner/admin optimistic-revision replacement of normalized active local-location/business-unit mappings.';
comment on function public.enable_original_kpi_catalog(uuid, text[]) is
  'Idempotently publishes selected (or all for an empty array) migration-owned original catalog definitions without creating facts or targets.';

insert into public.schema_releases (release_marker)
values ('20260819001500_servicetitan_discovery_kpi_catalog');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260819001500_servicetitan_discovery_kpi_catalog'
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) = 36
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
    select release.release_marker from public.schema_releases release
    order by release.released_at desc, release.release_marker desc limit 1
  ) marker;
$$;
revoke all on function public.get_release_readiness() from public;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;

commit;
