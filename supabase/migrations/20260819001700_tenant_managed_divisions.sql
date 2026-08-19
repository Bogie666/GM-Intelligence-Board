begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Tenant-managed divisions replace the fixed HVAC/plumbing/electrical/other
-- classification on ServiceTitan business-unit mappings. Division identity is
-- organization-owned and stable across connection and business-unit changes.
create table public.organization_divisions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  sort_order integer not null check (sort_order >= 0),
  created_by uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  archived_at timestamptz,
  constraint organization_divisions_tenant_identity_unique unique (organization_id, id),
  constraint organization_divisions_creator_fk
    foreign key (organization_id, created_by)
    references public.organization_memberships(organization_id, profile_id) on delete restrict,
  constraint organization_divisions_name_check check (
    pg_catalog.length(pg_catalog.btrim(name)) between 1 and 80
    and name = pg_catalog.btrim(name)
    and name !~ '[[:cntrl:]]'
    and pg_catalog.lower(name) not in ('not mapped', 'unmapped')
  ),
  constraint organization_divisions_archive_state_check check (
    (status = 'active' and archived_at is null)
    or (status = 'archived' and archived_at is not null)
  )
);
create unique index organization_divisions_name_unique
  on public.organization_divisions (organization_id, pg_catalog.lower(name));
create index organization_divisions_order_idx
  on public.organization_divisions (organization_id, status, sort_order, id);
comment on table public.organization_divisions is
  'Tenant-owned operational divisions used to classify ServiceTitan business units. Not Mapped is an absence of a mapping, never a division.';

-- Backfill every fixed trade value that has ever been used by an organization.
-- This is intentionally generic even though the first production tenant has no mappings.
-- Lock before the initial scan so no legacy mapping can appear between the
-- division seed and the division_id backfill.
lock table public.service_titan_business_unit_mappings in share row exclusive mode;
insert into public.organization_divisions (
  organization_id, name, status, sort_order, created_by
)
select distinct on (mapping.organization_id, mapping.trade)
  mapping.organization_id,
  case mapping.trade
    when 'hvac' then 'HVAC'
    when 'plumbing' then 'Plumbing'
    when 'electrical' then 'Electrical'
    else 'Other'
  end,
  'active',
  case mapping.trade
    when 'hvac' then 10
    when 'plumbing' then 20
    when 'electrical' then 30
    else 40
  end,
  mapping.mapped_by
from public.service_titan_business_unit_mappings mapping
order by mapping.organization_id, mapping.trade, mapping.mapped_at asc, mapping.id asc;

alter table public.service_titan_business_unit_mappings
  add column division_id uuid;
update public.service_titan_business_unit_mappings mapping
set division_id = division.id
from public.organization_divisions division
where division.organization_id = mapping.organization_id
  and pg_catalog.lower(division.name) = case mapping.trade
    when 'hvac' then 'hvac'
    when 'plumbing' then 'plumbing'
    when 'electrical' then 'electrical'
    else 'other'
  end;

do $$
begin
  if exists (
    select 1 from public.service_titan_business_unit_mappings mapping
    where mapping.division_id is null
  ) then
    raise exception 'legacy ServiceTitan trade mappings were not completely backfilled';
  end if;
end;
$$;

alter table public.service_titan_business_unit_mappings
  alter column division_id set not null,
  add constraint st_business_unit_mappings_division_fk
    foreign key (organization_id, division_id)
    references public.organization_divisions(organization_id, id) on delete restrict;
drop index public.st_business_unit_mappings_location_idx;
create index st_business_unit_mappings_location_idx
  on public.service_titan_business_unit_mappings (organization_id, location_id, division_id)
  where revoked_at is null;
create index st_business_unit_mappings_division_idx
  on public.service_titan_business_unit_mappings (organization_id, division_id);
-- Expand/compatible rollout: the new application never reads or writes trade,
-- but rolling release instances may still use it through the legacy adapter.
-- A later contract migration may remove it after the fleet is fully upgraded.
alter table public.service_titan_business_unit_mappings
  alter column trade drop not null;

comment on table public.service_titan_business_unit_mappings is
  'Revision-pinned mapping of a discovered ServiceTitan business unit to one tenant location and one tenant-managed division.';

-- Keep configuration audit coverage explicit and fail closed for unknown tables.
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
    'organizations', 'locations', 'organization_memberships', 'organization_divisions',
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

create trigger organization_divisions_configuration_audit
after insert or update or delete on public.organization_divisions
for each row execute function public.record_configuration_audit_event();
create trigger organization_divisions_set_updated_at
before update on public.organization_divisions
for each row execute function public.set_updated_at();

-- Creating serializes on the tenant row so concurrent inserts receive distinct order values.
create or replace function public.create_organization_division(
  p_organization_id uuid,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  new_id uuid;
  next_sort_order integer;
  normalized_name text := pg_catalog.btrim(p_name);
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid() and membership.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;
  perform 1 from public.organizations organization
  where organization.id = p_organization_id and organization.status = 'active'
  for update;
  if not found then raise exception 'active organization was not found' using errcode = 'P0002'; end if;
  if normalized_name is null
     or pg_catalog.length(normalized_name) not between 1 and 80
     or normalized_name ~ '[[:cntrl:]]'
     or pg_catalog.lower(normalized_name) in ('not mapped', 'unmapped') then
    raise exception 'division name is invalid or reserved' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.max(division.sort_order), 0) + 10 into next_sort_order
  from public.organization_divisions division
  where division.organization_id = p_organization_id;
  insert into public.organization_divisions (
    organization_id, name, status, sort_order, created_by
  ) values (
    p_organization_id, normalized_name, 'active', next_sort_order, auth.uid()
  ) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.rename_organization_division(
  p_organization_id uuid,
  p_division_id uuid,
  p_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  normalized_name text := pg_catalog.btrim(p_name);
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid() and membership.status = 'active'
    and organization.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;
  if normalized_name is null
     or pg_catalog.length(normalized_name) not between 1 and 80
     or normalized_name ~ '[[:cntrl:]]'
     or pg_catalog.lower(normalized_name) in ('not mapped', 'unmapped') then
    raise exception 'division name is invalid or reserved' using errcode = '22023';
  end if;
  update public.organization_divisions division
  set name = normalized_name
  where division.organization_id = p_organization_id and division.id = p_division_id;
  if not found then raise exception 'division was not found' using errcode = 'P0002'; end if;
  return true;
end;
$$;

create or replace function public.set_organization_division_status(
  p_organization_id uuid,
  p_division_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  current_status text;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid() and membership.status = 'active'
    and organization.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'archived') then
    raise exception 'division status is invalid' using errcode = '22023';
  end if;
  select division.status into current_status
  from public.organization_divisions division
  where division.organization_id = p_organization_id and division.id = p_division_id
  for update;
  if current_status is null then raise exception 'division was not found' using errcode = 'P0002'; end if;
  if current_status = p_status then return true; end if;
  if p_status = 'archived' and exists (
    select 1 from public.service_titan_business_unit_mappings mapping
    where mapping.organization_id = p_organization_id
      and mapping.division_id = p_division_id and mapping.revoked_at is null
  ) then
    raise exception 'a division with active business-unit mappings cannot be archived' using errcode = '55000';
  end if;
  update public.organization_divisions division
  set status = p_status,
      archived_at = case when p_status = 'archived' then pg_catalog.clock_timestamp() else null end
  where division.organization_id = p_organization_id and division.id = p_division_id;
  return true;
end;
$$;

create or replace function public.move_organization_division(
  p_organization_id uuid,
  p_division_id uuid,
  p_direction text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  current_order integer;
  neighbor_id uuid;
  neighbor_order integer;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid() and membership.status = 'active'
    and organization.status = 'active';
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;
  if p_direction is null or p_direction not in ('up', 'down') then
    raise exception 'division move direction is invalid' using errcode = '22023';
  end if;
  perform 1 from public.organization_divisions division
  where division.organization_id = p_organization_id and division.status = 'active'
  order by division.sort_order, division.id
  for update;
  select division.sort_order into current_order
  from public.organization_divisions division
  where division.organization_id = p_organization_id
    and division.id = p_division_id and division.status = 'active';
  if current_order is null then raise exception 'active division was not found' using errcode = 'P0002'; end if;
  if p_direction = 'up' then
    select division.id, division.sort_order into neighbor_id, neighbor_order
    from public.organization_divisions division
    where division.organization_id = p_organization_id and division.status = 'active'
      and (division.sort_order, division.id) < (current_order, p_division_id)
    order by division.sort_order desc, division.id desc limit 1;
  else
    select division.id, division.sort_order into neighbor_id, neighbor_order
    from public.organization_divisions division
    where division.organization_id = p_organization_id and division.status = 'active'
      and (division.sort_order, division.id) > (current_order, p_division_id)
    order by division.sort_order asc, division.id asc limit 1;
  end if;
  if neighbor_id is null then return false; end if;
  update public.organization_divisions division
  set sort_order = case when division.id = p_division_id then neighbor_order else current_order end
  where division.organization_id = p_organization_id
    and division.id in (p_division_id, neighbor_id);
  return true;
end;
$$;

-- Mapping replacement now accepts stable same-tenant division IDs. Omitted rows
-- remain visibly Not Mapped; callers may save partial progress, but readiness
-- requires exact coverage of the current active discovery revision.
create or replace function public.replace_service_titan_business_unit_division_mappings(
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
  mapped_division_id uuid;
  provider_id text;
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

  for mapping_item in select value from pg_catalog.jsonb_array_elements(p_mappings)
  loop
    if pg_catalog.jsonb_typeof(mapping_item) <> 'object'
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(mapping_item) key
         where key not in ('locationId', 'providerBusinessUnitId', 'divisionId')
       )
       or not (mapping_item ?& array['locationId', 'providerBusinessUnitId', 'divisionId'])
       or pg_catalog.jsonb_typeof(mapping_item -> 'locationId') <> 'string'
       or pg_catalog.jsonb_typeof(mapping_item -> 'providerBusinessUnitId') <> 'string'
       or pg_catalog.jsonb_typeof(mapping_item -> 'divisionId') <> 'string'
       or (mapping_item ->> 'locationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or (mapping_item ->> 'divisionId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'business-unit mapping item shape is invalid' using errcode = '22023';
    end if;
    mapped_location_id := (mapping_item ->> 'locationId')::uuid;
    mapped_division_id := (mapping_item ->> 'divisionId')::uuid;
    provider_id := mapping_item ->> 'providerBusinessUnitId';
    if provider_id is null or provider_id <> pg_catalog.btrim(provider_id)
       or pg_catalog.length(provider_id) not between 1 and 160
       or provider_id ~ '[[:cntrl:]]' then
      raise exception 'business-unit provider identifier is invalid' using errcode = '22023';
    end if;
    perform 1 from public.locations location
    where location.organization_id = p_organization_id
      and location.id = mapped_location_id and location.status = 'active'
    for share;
    if not found then
      raise exception 'mapping location is not active in this organization' using errcode = '22023';
    end if;
    perform 1 from public.service_titan_connection_locations assignment
    where assignment.organization_id = p_organization_id
      and assignment.connection_id = p_connection_id
      and assignment.location_id = mapped_location_id
      and assignment.revoked_at is null
    for share;
    if not found then
      raise exception 'mapping location is not actively assigned to this connection' using errcode = '22023';
    end if;
    perform 1 from public.organization_divisions division
    where division.organization_id = p_organization_id
      and division.id = mapped_division_id and division.status = 'active'
    for share;
    if not found then
      raise exception 'mapping division is not active in this organization' using errcode = '22023';
    end if;
    perform 1 from public.service_titan_business_units unit
    where unit.organization_id = p_organization_id and unit.connection_id = p_connection_id
      and unit.provider_business_unit_id = provider_id and unit.active
      and unit.discovery_revision = p_discovery_revision
      and unit.discovery_run_id = current_run_id
    for share;
    if not found then
      raise exception 'mapping business unit is not active in the current discovery revision' using errcode = '22023';
    end if;
  end loop;

  if (select pg_catalog.count(distinct value ->> 'providerBusinessUnitId')
      from pg_catalog.jsonb_array_elements(p_mappings)) <> mapping_count then
    raise exception 'one provider business unit cannot map more than once' using errcode = '23505';
  end if;

  update public.service_titan_business_unit_mappings mapping
  set revoked_at = pg_catalog.clock_timestamp()
  where mapping.organization_id = p_organization_id
    and mapping.connection_id = p_connection_id and mapping.revoked_at is null;
  for mapping_item in select value from pg_catalog.jsonb_array_elements(p_mappings)
  loop
    insert into public.service_titan_business_unit_mappings (
      organization_id, connection_id, location_id, provider_business_unit_id,
      division_id, trade, discovery_revision, discovery_run_id, mapped_by
    ) values (
      p_organization_id, p_connection_id, (mapping_item ->> 'locationId')::uuid,
      mapping_item ->> 'providerBusinessUnitId', (mapping_item ->> 'divisionId')::uuid,
      (
        select case pg_catalog.lower(division.name)
          when 'hvac' then 'hvac'
          when 'plumbing' then 'plumbing'
          when 'electrical' then 'electrical'
          when 'other' then 'other'
          else 'other'
        end
        from public.organization_divisions division
        where division.organization_id = p_organization_id
          and division.id = (mapping_item ->> 'divisionId')::uuid
      ),
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

-- Rolling-release adapter for schema-016 application instances. It accepts the
-- old fixed-trade payload, ensures the matching canonical divisions exist, and
-- delegates every tenant/location/discovery check to the division-native RPC.
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
  mapping_item jsonb;
  legacy_trade text;
  legacy_name text;
  transformed_mappings jsonb := '[]'::jsonb;
  resolved_division_id uuid;
  result_count integer;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid() and membership.status = 'active'
  for share;
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;
  perform 1 from public.organizations organization
  where organization.id = p_organization_id and organization.status = 'active'
  for update;
  if not found then raise exception 'active organization was not found' using errcode = 'P0002'; end if;
  if p_mappings is null or pg_catalog.jsonb_typeof(p_mappings) <> 'array'
     or pg_catalog.jsonb_array_length(p_mappings) > 10000
     or public.jsonb_has_forbidden_credential_keys(p_mappings) then
    raise exception 'legacy normalized mapping array is required' using errcode = '22023';
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
       or (mapping_item ->> 'trade') not in ('hvac', 'plumbing', 'electrical', 'other') then
      raise exception 'legacy business-unit mapping item shape is invalid' using errcode = '22023';
    end if;
    legacy_trade := mapping_item ->> 'trade';
    legacy_name := case legacy_trade
      when 'hvac' then 'HVAC' when 'plumbing' then 'Plumbing'
      when 'electrical' then 'Electrical' else 'Other' end;
    resolved_division_id := null;
    -- Preserve an existing division-native choice when a schema-016 form merely
    -- resubmits its compatible trade projection during the rolling cutover.
    select mapping.division_id into resolved_division_id
    from public.service_titan_business_unit_mappings mapping
    join public.organization_divisions division
      on division.organization_id = mapping.organization_id
     and division.id = mapping.division_id and division.status = 'active'
    where mapping.organization_id = p_organization_id
      and mapping.connection_id = p_connection_id
      and mapping.provider_business_unit_id = mapping_item ->> 'providerBusinessUnitId'
      and mapping.revoked_at is null and mapping.trade = legacy_trade
    order by mapping.mapped_at desc, mapping.id desc
    limit 1;
    if resolved_division_id is null then
      insert into public.organization_divisions (
        organization_id, name, status, sort_order, created_by
      ) values (
        p_organization_id, legacy_name, 'active',
        (select coalesce(pg_catalog.max(division.sort_order), 0) + 10
         from public.organization_divisions division
         where division.organization_id = p_organization_id),
        auth.uid()
      ) on conflict (organization_id, pg_catalog.lower(name)) do nothing;
      select division.id into resolved_division_id
      from public.organization_divisions division
      where division.organization_id = p_organization_id
        and pg_catalog.lower(division.name) = pg_catalog.lower(legacy_name)
        and division.status = 'active';
    end if;
    if resolved_division_id is null then
      raise exception 'legacy trade division is archived or unavailable' using errcode = '55000';
    end if;
    transformed_mappings := transformed_mappings || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'locationId', mapping_item ->> 'locationId',
        'providerBusinessUnitId', mapping_item ->> 'providerBusinessUnitId',
        'divisionId', resolved_division_id
      )
    );
  end loop;

  result_count := public.replace_service_titan_business_unit_division_mappings(
    p_organization_id, p_connection_id, p_discovery_revision, transformed_mappings
  );
  update public.service_titan_business_unit_mappings mapping
  set trade = item.value ->> 'trade'
  from pg_catalog.jsonb_array_elements(p_mappings) item
  where mapping.organization_id = p_organization_id
    and mapping.connection_id = p_connection_id and mapping.revoked_at is null
    and mapping.provider_business_unit_id = item.value ->> 'providerBusinessUnitId';
  return result_count;
end;
$$;

-- Reconcile any stale active rows that predate this trigger. The latest completed
-- discovery must also belong to the connection's current credential revision.
with latest_discovery as (
  select distinct on (run.organization_id, run.connection_id)
    run.organization_id, run.connection_id, run.discovery_revision
  from public.service_titan_discovery_runs run
  join public.service_titan_connections connection
    on connection.organization_id = run.organization_id
   and connection.id = run.connection_id
   and connection.configuration_revision = run.configuration_revision
  where run.status = 'completed'
  order by run.organization_id, run.connection_id, run.completed_at desc, run.requested_at desc
), revoked as (
  update public.service_titan_business_unit_mappings mapping
  set revoked_at = pg_catalog.clock_timestamp()
  where mapping.revoked_at is null
    and mapping.discovery_revision is distinct from (
      select latest.discovery_revision
      from latest_discovery latest
      where latest.organization_id = mapping.organization_id
        and latest.connection_id = mapping.connection_id
    )
  returning mapping.organization_id, mapping.connection_id
), summarized as (
  select organization_id, connection_id, pg_catalog.count(*)::integer as revoked_count
  from revoked group by organization_id, connection_id
)
insert into public.audit_events (
  organization_id, actor_profile_id, action, resource_table, resource_id,
  before_state, after_state, request_id
)
select summary.organization_id, null, 'servicetitan.business_unit_mappings.stale',
  'service_titan_business_unit_mappings', summary.connection_id, null,
  pg_catalog.jsonb_build_object(
    'connectionId', summary.connection_id,
    'revokedMappingCount', summary.revoked_count,
    'reason', 'migration_017_latest_discovery_reconciliation'
  ),
  pg_catalog.current_setting('request.id', true)
from summarized summary;

create or replace function public.revoke_stale_business_unit_mappings_after_discovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked_count integer;
begin
  if new.status = 'completed'
     and (old.status is distinct from new.status or old.discovery_revision is distinct from new.discovery_revision) then
    update public.service_titan_business_unit_mappings mapping
    set revoked_at = pg_catalog.clock_timestamp()
    where mapping.organization_id = new.organization_id
      and mapping.connection_id = new.connection_id
      and mapping.revoked_at is null
      and mapping.discovery_revision is distinct from new.discovery_revision;
    get diagnostics revoked_count = row_count;
    if revoked_count > 0 then
      insert into public.audit_events (
        organization_id, actor_profile_id, action, resource_table, resource_id,
        before_state, after_state, request_id
      ) values (
        new.organization_id, null, 'servicetitan.business_unit_mappings.stale',
        'service_titan_business_unit_mappings', new.connection_id, null,
        pg_catalog.jsonb_build_object(
          'connectionId', new.connection_id,
          'discoveryRevision', new.discovery_revision,
          'revokedMappingCount', revoked_count
        ),
        pg_catalog.current_setting('request.id', true)
      );
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.revoke_stale_business_unit_mappings_after_discovery()
  from public, anon, authenticated, service_role;
create trigger service_titan_discovery_revoke_stale_mappings
after update of status, discovery_revision on public.service_titan_discovery_runs
for each row execute function public.revoke_stale_business_unit_mappings_after_discovery();

alter table public.organization_divisions enable row level security;
create policy organization_divisions_member_read on public.organization_divisions
for select to authenticated
using (public.has_organization_role(
  organization_id,
  array['owner', 'admin', 'brand_executive', 'general_manager', 'department_leader', 'viewer']
));
revoke all on table public.organization_divisions from public, anon, authenticated;
grant select (id, organization_id, name, status, sort_order, created_at, updated_at, archived_at)
  on public.organization_divisions to authenticated;

revoke all on function public.create_organization_division(uuid, text)
  from public, anon, service_role;
grant execute on function public.create_organization_division(uuid, text) to authenticated;
revoke all on function public.rename_organization_division(uuid, uuid, text)
  from public, anon, service_role;
grant execute on function public.rename_organization_division(uuid, uuid, text) to authenticated;
revoke all on function public.set_organization_division_status(uuid, uuid, text)
  from public, anon, service_role;
grant execute on function public.set_organization_division_status(uuid, uuid, text) to authenticated;
revoke all on function public.move_organization_division(uuid, uuid, text)
  from public, anon, service_role;
grant execute on function public.move_organization_division(uuid, uuid, text) to authenticated;
revoke all on function public.replace_service_titan_business_unit_division_mappings(uuid, uuid, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.replace_service_titan_business_unit_division_mappings(uuid, uuid, uuid, jsonb)
  to authenticated;
revoke all on function public.replace_service_titan_business_unit_mappings(uuid, uuid, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.replace_service_titan_business_unit_mappings(uuid, uuid, uuid, jsonb)
  to authenticated;

comment on function public.create_organization_division(uuid, text) is
  'Owner/admin creation of a uniquely named tenant division with serialized display ordering.';
comment on function public.rename_organization_division(uuid, uuid, text) is
  'Owner/admin rename of an existing tenant division while preserving its stable identifier.';
comment on function public.set_organization_division_status(uuid, uuid, text) is
  'Owner/admin archive or restore of a division; archive is blocked while current business-unit mappings reference it.';
comment on function public.move_organization_division(uuid, uuid, text) is
  'Owner/admin one-position move of an active tenant division.';
comment on function public.replace_service_titan_business_unit_division_mappings(uuid, uuid, uuid, jsonb) is
  'Owner/admin optimistic-revision replacement of active location-and-division mappings for current ServiceTitan business units.';
comment on function public.replace_service_titan_business_unit_mappings(uuid, uuid, uuid, jsonb) is
  'Temporary rolling-release adapter for schema-016 fixed-trade mapping payloads; remove only after the application fleet is division-native.';

insert into public.schema_releases (release_marker)
values ('20260819001700_tenant_managed_divisions');

-- Keep schema-016 web instances healthy during the DB-first rolling cutover. The
-- prior function selected the newest marker dynamically, which would otherwise
-- return 017 to an application that explicitly expects 016.
create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.schema_releases release
      where release.release_marker = '20260819001600_enterprise_admin_hardening'
    )
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
    '20260819001600_enterprise_admin_hardening'::text as release_marker;
$$;
revoke all on function public.get_release_readiness() from public;
grant execute on function public.get_release_readiness() to anon, authenticated, service_role;
comment on function public.get_release_readiness() is
  'Schema-016 compatibility gate retained during the tenant-managed-division rolling release.';

create or replace function public.get_division_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260819001700_tenant_managed_divisions'
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) = 36
      and not exists (
        select 1 from public.organization_divisions division
        where pg_catalog.lower(division.name) in ('not mapped', 'unmapped')
      )
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
revoke all on function public.get_division_release_readiness() from public;
grant execute on function public.get_division_release_readiness() to anon, authenticated, service_role;
comment on function public.get_division_release_readiness() is
  'Division-aware release gate. The legacy get_release_readiness RPC remains unchanged through the rolling cutover so schema-016 instances stay healthy.';

commit;
