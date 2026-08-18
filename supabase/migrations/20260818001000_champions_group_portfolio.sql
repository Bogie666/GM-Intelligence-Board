begin;

create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  name text not null check (length(btrim(name)) between 2 and 160),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.portfolio_memberships (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  role text not null check (role in ('owner', 'admin', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portfolio_id, profile_id)
);

create table public.portfolio_organizations (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'detached')),
  sort_order integer not null default 0 check (sort_order between 0 and 100000),
  attached_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portfolio_id, organization_id)
);

create table public.portfolio_audit_events (
  id bigint generated always as identity primary key,
  portfolio_id uuid not null references public.portfolios(id) on delete restrict deferrable initially deferred,
  event_type text not null check (length(btrim(event_type)) between 3 and 120),
  actor_kind text not null check (actor_kind in ('migration', 'service_role')),
  actor_identifier text not null check (length(btrim(actor_identifier)) between 2 and 160),
  target_profile_id uuid references public.profiles(id) on delete restrict,
  organization_id uuid,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index portfolio_memberships_profile_active_idx
  on public.portfolio_memberships (profile_id, portfolio_id)
  where status = 'active';
create index portfolio_memberships_portfolio_role_idx
  on public.portfolio_memberships (portfolio_id, role, status);
create index portfolio_organizations_organization_idx
  on public.portfolio_organizations (organization_id, portfolio_id, status);
create index portfolio_organizations_portfolio_active_idx
  on public.portfolio_organizations (portfolio_id, sort_order, organization_id)
  where status = 'active';
create index portfolio_audit_events_portfolio_created_idx
  on public.portfolio_audit_events (portfolio_id, created_at desc, id desc);

alter table public.portfolios enable row level security;
alter table public.portfolio_memberships enable row level security;
alter table public.portfolio_organizations enable row level security;
alter table public.portfolio_audit_events enable row level security;

revoke all on table public.portfolios from public, anon, authenticated;
revoke all on table public.portfolio_memberships from public, anon, authenticated;
revoke all on table public.portfolio_organizations from public, anon, authenticated;
revoke all on table public.portfolio_audit_events from public, anon, authenticated;
revoke all on sequence public.portfolio_audit_events_id_seq from public, anon, authenticated;
revoke all on table public.portfolios, public.portfolio_memberships, public.portfolio_organizations, public.portfolio_audit_events from service_role;
revoke all on sequence public.portfolio_audit_events_id_seq from service_role;
grant select on table public.portfolios, public.portfolio_memberships, public.portfolio_organizations, public.portfolio_audit_events to service_role;

create or replace function public.govern_portfolio_record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row jsonb;
  after_row jsonb;
  audit_portfolio_id uuid;
  audit_target_profile_id uuid;
  audit_organization_id uuid;
  operation_reason text := nullif(btrim(pg_catalog.current_setting('app.portfolio_operation_reason', true)), '');
  operation_actor_kind text := nullif(btrim(pg_catalog.current_setting('app.portfolio_operation_actor_kind', true)), '');
  operation_actor_identifier text := nullif(btrim(pg_catalog.current_setting('app.portfolio_operation_actor_identifier', true)), '');
begin
  before_row := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_row := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  if tg_op = 'DELETE' and not (
    tg_table_name = 'portfolio_organizations'
    and operation_actor_identifier = 'prepare_empty_qa_brand_removal'
  ) then
    raise exception 'portfolio governance records use lifecycle status transitions, not deletes' using errcode = '42501';
  end if;
  if operation_reason is null or length(operation_reason) < 3 then
    raise exception 'portfolio operation reason is required' using errcode = '42501';
  end if;
  if operation_actor_kind not in ('migration', 'service_role') or operation_actor_identifier is null then
    raise exception 'portfolio operation actor context is required' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if tg_table_name = 'portfolios' and old.id is distinct from new.id then
      raise exception 'portfolio identity is immutable' using errcode = '23514';
    elsif tg_table_name = 'portfolio_memberships' and
      (old.id is distinct from new.id or old.portfolio_id is distinct from new.portfolio_id or old.profile_id is distinct from new.profile_id) then
      raise exception 'portfolio membership identity is immutable' using errcode = '23514';
    elsif tg_table_name = 'portfolio_organizations' and
      (old.id is distinct from new.id or old.portfolio_id is distinct from new.portfolio_id or old.organization_id is distinct from new.organization_id) then
      raise exception 'portfolio brand attachment identity is immutable' using errcode = '23514';
    end if;
    new.updated_at := pg_catalog.now();
    after_row := to_jsonb(new);
  end if;

  if tg_table_name = 'portfolios' then
    audit_portfolio_id := coalesce((after_row ->> 'id')::uuid, (before_row ->> 'id')::uuid);
  else
    audit_portfolio_id := coalesce((after_row ->> 'portfolio_id')::uuid, (before_row ->> 'portfolio_id')::uuid);
  end if;
  if tg_table_name = 'portfolio_memberships' then
    audit_target_profile_id := coalesce((after_row ->> 'profile_id')::uuid, (before_row ->> 'profile_id')::uuid);
  end if;
  if tg_table_name = 'portfolio_organizations' then
    audit_organization_id := coalesce((after_row ->> 'organization_id')::uuid, (before_row ->> 'organization_id')::uuid);
  end if;

  insert into public.portfolio_audit_events (
    portfolio_id, event_type, actor_kind, actor_identifier, target_profile_id,
    organization_id, reason, before_state, after_state
  ) values (
    audit_portfolio_id, tg_table_name || '.' || lower(tg_op), operation_actor_kind,
    operation_actor_identifier, audit_target_profile_id, audit_organization_id,
    operation_reason, before_row, after_row
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger govern_portfolios
before insert or update or delete on public.portfolios
for each row execute function public.govern_portfolio_record_change();
create trigger govern_portfolio_memberships
before insert or update or delete on public.portfolio_memberships
for each row execute function public.govern_portfolio_record_change();
create trigger govern_portfolio_organizations
before insert or update or delete on public.portfolio_organizations
for each row execute function public.govern_portfolio_record_change();

create or replace function public.deny_portfolio_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'portfolio audit events are append-only' using errcode = '42501';
end;
$$;
create trigger deny_portfolio_audit_mutation
before update or delete on public.portfolio_audit_events
for each row execute function public.deny_portfolio_audit_mutation();

select pg_catalog.set_config('app.portfolio_operation_reason', 'Seed Champions Group portfolio and attach existing active brands', true);
select pg_catalog.set_config('app.portfolio_operation_actor_kind', 'migration', true);
select pg_catalog.set_config('app.portfolio_operation_actor_identifier', '20260818001000_champions_group_portfolio', true);

insert into public.portfolios (id, slug, name, status)
values ('c1000000-0000-4000-8000-000000000001', 'champions-group', 'Champions Group', 'active');

insert into public.portfolio_organizations (portfolio_id, organization_id, status, sort_order)
select 'c1000000-0000-4000-8000-000000000001', organization.id, 'active',
       row_number() over (order by lower(organization.name), organization.id)::integer * 10
from public.organizations organization
where organization.status = 'active';

create or replace function public.grant_portfolio_owner_access(
  p_portfolio_id uuid,
  p_profile_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_membership public.portfolio_memberships%rowtype;
  membership_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'operation reason is required' using errcode = '22023';
  end if;
  perform 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id for update;
  if not found or not exists (select 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id and portfolio.status = 'active') then
    raise exception 'active portfolio does not exist' using errcode = '22023';
  end if;
  if p_profile_id is null or not exists (select 1 from public.profiles profile where profile.id = p_profile_id) then
    raise exception 'target profile does not exist' using errcode = '22023';
  end if;

  select * into existing_membership
  from public.portfolio_memberships membership
  where membership.portfolio_id = p_portfolio_id and membership.profile_id = p_profile_id
  for update;
  if found then
    if existing_membership.role = 'owner' and existing_membership.status = 'active' then
      return existing_membership.id;
    end if;
    raise exception 'conflicting portfolio membership state exists' using errcode = '23514';
  end if;

  perform pg_catalog.set_config('app.portfolio_operation_reason', btrim(p_reason), true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'service_role', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'grant_portfolio_owner_access', true);
  insert into public.portfolio_memberships (portfolio_id, profile_id, role, status)
  values (p_portfolio_id, p_profile_id, 'owner', 'active')
  returning id into membership_id;
  return membership_id;
end;
$$;

create or replace function public.revoke_portfolio_membership(
  p_portfolio_id uuid,
  p_profile_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_membership public.portfolio_memberships%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'operation reason is required' using errcode = '22023';
  end if;
  perform 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id for update;
  if not found then raise exception 'portfolio does not exist' using errcode = '22023'; end if;
  select * into existing_membership from public.portfolio_memberships membership
  where membership.portfolio_id = p_portfolio_id and membership.profile_id = p_profile_id for update;
  if not found then raise exception 'portfolio membership does not exist' using errcode = '22023'; end if;
  if existing_membership.status = 'revoked' then return existing_membership.id; end if;
  if existing_membership.role = 'owner' and existing_membership.status = 'active' and (
    select count(*) from public.portfolio_memberships membership
    where membership.portfolio_id = p_portfolio_id and membership.role = 'owner' and membership.status = 'active'
  ) <= 1 then
    raise exception 'cannot revoke the last active portfolio owner' using errcode = '23514';
  end if;
  perform pg_catalog.set_config('app.portfolio_operation_reason', btrim(p_reason), true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'service_role', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'revoke_portfolio_membership', true);
  update public.portfolio_memberships set status = 'revoked'
  where id = existing_membership.id;
  return existing_membership.id;
end;
$$;

create or replace function public.attach_brand_to_portfolio(
  p_portfolio_id uuid,
  p_organization_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_attachment public.portfolio_organizations%rowtype;
  attachment_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'operation reason is required' using errcode = '22023';
  end if;
  perform 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id for update;
  if not found or not exists (select 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id and portfolio.status = 'active') then
    raise exception 'active portfolio does not exist' using errcode = '22023';
  end if;
  perform 1 from public.organizations organization where organization.id = p_organization_id for update;
  if not found or not exists (select 1 from public.organizations organization where organization.id = p_organization_id and organization.status = 'active') then
    raise exception 'active brand does not exist' using errcode = '22023';
  end if;
  select * into existing_attachment from public.portfolio_organizations attachment
  where attachment.portfolio_id = p_portfolio_id and attachment.organization_id = p_organization_id for update;
  if found then
    if existing_attachment.status = 'active' then return existing_attachment.id; end if;
    raise exception 'conflicting detached portfolio brand state exists' using errcode = '23514';
  end if;
  perform pg_catalog.set_config('app.portfolio_operation_reason', btrim(p_reason), true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'service_role', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'attach_brand_to_portfolio', true);
  insert into public.portfolio_organizations (portfolio_id, organization_id, status)
  values (p_portfolio_id, p_organization_id, 'active') returning id into attachment_id;
  return attachment_id;
end;
$$;

create or replace function public.detach_brand_from_portfolio(
  p_portfolio_id uuid,
  p_organization_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_attachment public.portfolio_organizations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'operation reason is required' using errcode = '22023';
  end if;
  perform 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id for update;
  if not found then raise exception 'portfolio does not exist' using errcode = '22023'; end if;
  perform 1 from public.organizations organization where organization.id = p_organization_id for update;
  if not found then raise exception 'brand does not exist' using errcode = '22023'; end if;
  select * into existing_attachment from public.portfolio_organizations attachment
  where attachment.portfolio_id = p_portfolio_id and attachment.organization_id = p_organization_id for update;
  if not found then raise exception 'portfolio brand attachment does not exist' using errcode = '22023'; end if;
  if existing_attachment.status = 'detached' then return existing_attachment.id; end if;
  perform pg_catalog.set_config('app.portfolio_operation_reason', btrim(p_reason), true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'service_role', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'detach_brand_from_portfolio', true);
  update public.portfolio_organizations set status = 'detached' where id = existing_attachment.id;
  return existing_attachment.id;
end;
$$;

create or replace function public.finalize_brand_portfolio_onboarding(
  p_portfolio_id uuid,
  p_organization_id uuid,
  p_platform_owner_profile_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if p_portfolio_id is null or p_organization_id is null or p_platform_owner_profile_id is null then
    raise exception 'portfolio, organization, and platform owner IDs are required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'operation reason is required' using errcode = '22023';
  end if;
  tenant_count := public.grant_owner_access_to_all_tenants(p_platform_owner_profile_id);
  perform public.attach_brand_to_portfolio(p_portfolio_id, p_organization_id, p_reason);
  return tenant_count;
end;
$$;

create or replace function public.prepare_empty_qa_brand_removal(
  p_portfolio_id uuid,
  p_organization_id uuid,
  p_qa_user_id uuid,
  p_platform_owner_profile_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_slug text;
  blocking_row_count bigint;
  expected_membership_count integer := case when p_qa_user_id = p_platform_owner_profile_id then 1 else 2 end;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  if p_portfolio_id is null or p_organization_id is null or p_qa_user_id is null or p_platform_owner_profile_id is null then
    raise exception 'portfolio, organization, QA owner, and platform owner IDs are required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'operation reason is required' using errcode = '22023';
  end if;
  perform 1 from public.portfolios portfolio where portfolio.id = p_portfolio_id for update;
  if not found then raise exception 'portfolio does not exist' using errcode = '22023'; end if;
  select organization.slug into actual_slug from public.organizations organization
  where organization.id = p_organization_id for update;
  if actual_slug is null or actual_slug !~ '^qa-[a-z0-9][a-z0-9-]{0,59}[a-z0-9]$' then
    raise exception 'portfolio QA preparation requires an exact qa-* brand' using errcode = '22023';
  end if;
  perform 1 from public.portfolio_organizations attachment
  where attachment.portfolio_id = p_portfolio_id and attachment.organization_id = p_organization_id for update;
  if not found then
    if exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id and membership.profile_id = p_platform_owner_profile_id
    ) then
      raise exception 'portfolio attachment is absent while platform-owner brand membership remains' using errcode = '23514';
    end if;
    return true;
  end if;

  if (select count(*) from public.organization_memberships membership where membership.organization_id = p_organization_id) <> expected_membership_count
    or not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id and membership.profile_id = p_qa_user_id
        and membership.role = 'owner' and membership.status = 'active'
    )
    or (p_qa_user_id <> p_platform_owner_profile_id and not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id and membership.profile_id = p_platform_owner_profile_id
        and membership.role = 'owner' and membership.status = 'active'
    )) then
    raise exception 'QA preparation requires only the exact active QA and platform owner memberships' using errcode = '23514';
  end if;

  select pg_catalog.sum(row_count) into blocking_row_count
  from (
    select pg_catalog.count(*) as row_count from public.locations where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_connections where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_connection_locations where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_report_sources where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.service_titan_report_evidence where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.custom_kpi_definitions where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.custom_kpi_location_bindings where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.custom_kpi_binding_evidence where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.kpi_observations where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.kpi_targets where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.layout_templates where organization_id = p_organization_id
    union all select pg_catalog.count(*) from public.profile_layouts where organization_id = p_organization_id
  ) qa_rows;
  if blocking_row_count <> 0 then
    raise exception 'QA brand contains configuration or fact rows and will not be prepared for removal' using errcode = '23514';
  end if;

  perform pg_catalog.set_config('app.qa_teardown_organization_id', p_organization_id::text, true);
  perform pg_catalog.set_config('app.portfolio_operation_reason', btrim(p_reason), true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'service_role', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'prepare_empty_qa_brand_removal', true);
  delete from public.portfolio_organizations attachment
  where attachment.portfolio_id = p_portfolio_id and attachment.organization_id = p_organization_id;
  if p_qa_user_id <> p_platform_owner_profile_id then
    delete from public.organization_memberships membership
    where membership.organization_id = p_organization_id and membership.profile_id = p_platform_owner_profile_id;
  end if;
  return true;
end;
$$;

create or replace function public.remove_empty_qa_brand_from_portfolio(
  p_portfolio_id uuid,
  p_organization_id uuid,
  p_qa_user_id uuid,
  p_platform_owner_profile_id uuid,
  p_expected_slug text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role authorization is required' using errcode = '42501';
  end if;
  perform public.prepare_empty_qa_brand_removal(
    p_portfolio_id,
    p_organization_id,
    p_qa_user_id,
    p_platform_owner_profile_id,
    p_reason
  );
  if public.remove_empty_qa_tenant(p_organization_id, p_qa_user_id, p_expected_slug) is distinct from true then
    raise exception 'legacy QA tenant removal did not complete' using errcode = '23514';
  end if;
  return true;
end;
$$;

create or replace function public.has_portfolio_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then false else (
    select count(*) = 1
    from public.portfolio_memberships membership
    join public.portfolios portfolio on portfolio.id = membership.portfolio_id
    where membership.profile_id = auth.uid()
      and membership.status = 'active'
      and portfolio.status = 'active'
  ) end;
$$;

create or replace function public.can_access_portfolio_brand(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with active_portfolio as (
    select membership.portfolio_id
    from public.portfolio_memberships membership
    join public.portfolios portfolio on portfolio.id = membership.portfolio_id
    where membership.profile_id = auth.uid() and membership.status = 'active' and portfolio.status = 'active'
  )
  select auth.uid() is not null
    and (select count(*) from active_portfolio) = 1
    and exists (
      select 1
      from active_portfolio selected
      join public.portfolio_organizations attachment on attachment.portfolio_id = selected.portfolio_id
      join public.organizations organization on organization.id = attachment.organization_id
      join public.organization_memberships membership
        on membership.organization_id = organization.id and membership.profile_id = auth.uid()
      where attachment.organization_id = p_organization_id
        and attachment.status = 'active' and organization.status = 'active' and membership.status = 'active'
    );
$$;

create or replace function public.get_portfolio_overview()
returns table (
  portfolio_id uuid,
  portfolio_slug text,
  portfolio_name text,
  portfolio_role text,
  brand_id uuid,
  brand_slug text,
  brand_name text,
  active_location_count integer,
  enabled_connection_count integer,
  ready_connection_count integer,
  assigned_location_count integer,
  published_kpi_count integer,
  approved_binding_count integer,
  observed_binding_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  selected_portfolio_id uuid;
  selected_portfolio_role text;
  portfolio_membership_count integer;
  active_organization_count integer;
  attached_brand_count integer;
  authorized_brand_count integer;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '42501';
  end if;
  select count(*)::integer
  into portfolio_membership_count
  from public.portfolio_memberships membership
  join public.portfolios portfolio on portfolio.id = membership.portfolio_id
  where membership.profile_id = auth.uid() and membership.status = 'active' and portfolio.status = 'active';
  if portfolio_membership_count <> 1 then
    raise exception 'exactly one active portfolio membership is required' using errcode = '42501';
  end if;
  select membership.portfolio_id, membership.role
  into selected_portfolio_id, selected_portfolio_role
  from public.portfolio_memberships membership
  join public.portfolios portfolio on portfolio.id = membership.portfolio_id
  where membership.profile_id = auth.uid() and membership.status = 'active' and portfolio.status = 'active';
  select count(*)::integer into active_organization_count
  from public.organizations organization
  where organization.status = 'active';
  select count(*)::integer into attached_brand_count
  from public.portfolio_organizations attachment
  join public.organizations organization on organization.id = attachment.organization_id
  where attachment.portfolio_id = selected_portfolio_id
    and attachment.status = 'active' and organization.status = 'active';
  if attached_brand_count <> active_organization_count then
    raise exception 'portfolio attachment coverage is incomplete' using errcode = '42501';
  end if;
  select count(*)::integer into authorized_brand_count
  from public.portfolio_organizations attachment
  join public.organizations organization on organization.id = attachment.organization_id
  join public.organization_memberships membership
    on membership.organization_id = organization.id and membership.profile_id = auth.uid()
  where attachment.portfolio_id = selected_portfolio_id
    and attachment.status = 'active' and organization.status = 'active' and membership.status = 'active';
  if authorized_brand_count <> attached_brand_count then
    raise exception 'portfolio brand membership coverage is incomplete' using errcode = '42501';
  end if;

  return query
  select portfolio.id, portfolio.slug, portfolio.name, selected_portfolio_role,
    organization.id, organization.slug, organization.name,
    (select count(distinct location.id)::integer from public.locations location
      where location.organization_id = organization.id and location.status = 'active'),
    (select count(distinct connection.id)::integer from public.service_titan_connections connection
      where connection.organization_id = organization.id and connection.status not in ('disabled', 'archived')),
    (select count(distinct connection.id)::integer from public.service_titan_connections connection
      where connection.organization_id = organization.id and connection.status = 'ready' and connection.last_validated_at is not null),
    (select count(distinct location.id)::integer
      from public.locations location
      join public.service_titan_connection_locations assignment
        on assignment.location_id = location.id and assignment.organization_id = organization.id and assignment.revoked_at is null
      join public.service_titan_connections connection
        on connection.id = assignment.connection_id and connection.organization_id = organization.id
      where location.organization_id = organization.id and location.status = 'active'
        and connection.status not in ('disabled', 'archived')),
    (select count(distinct definition.id)::integer from public.custom_kpi_definitions definition
      where definition.organization_id = organization.id and definition.type = 'service_titan' and definition.lifecycle = 'published'),
    (select count(distinct binding.id)::integer from public.custom_kpi_location_bindings binding
      where binding.organization_id = organization.id and binding.approval_status = 'approved'),
    (select count(distinct binding.id)::integer
      from public.custom_kpi_location_bindings binding
      where binding.organization_id = organization.id and binding.approval_status = 'approved'
        and binding.canonical_source_fingerprint is not null
        and exists (
          select 1 from public.kpi_observations observation
          where observation.organization_id = organization.id
            and observation.binding_id = binding.id
            and observation.source_fingerprint = binding.canonical_source_fingerprint
            and observation.status = 'valid'
        ))
  from public.portfolios portfolio
  join public.portfolio_organizations attachment on attachment.portfolio_id = portfolio.id and attachment.status = 'active'
  join public.organizations organization on organization.id = attachment.organization_id and organization.status = 'active'
  where portfolio.id = selected_portfolio_id
  order by attachment.sort_order, lower(organization.name), organization.id;
end;
$$;

revoke all on function public.govern_portfolio_record_change() from public, anon, authenticated;
revoke all on function public.deny_portfolio_audit_mutation() from public, anon, authenticated;
revoke all on function public.grant_portfolio_owner_access(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_portfolio_membership(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.attach_brand_to_portfolio(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.detach_brand_from_portfolio(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_brand_portfolio_onboarding(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.prepare_empty_qa_brand_removal(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.remove_empty_qa_brand_from_portfolio(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.has_portfolio_access() from public, anon;
revoke all on function public.can_access_portfolio_brand(uuid) from public, anon;
revoke all on function public.get_portfolio_overview() from public, anon;
grant execute on function public.grant_portfolio_owner_access(uuid, uuid, text) to service_role;
grant execute on function public.revoke_portfolio_membership(uuid, uuid, text) to service_role;
grant execute on function public.attach_brand_to_portfolio(uuid, uuid, text) to service_role;
grant execute on function public.detach_brand_from_portfolio(uuid, uuid, text) to service_role;
grant execute on function public.finalize_brand_portfolio_onboarding(uuid, uuid, uuid, text) to service_role;
grant execute on function public.remove_empty_qa_brand_from_portfolio(uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.has_portfolio_access() to authenticated, service_role;
grant execute on function public.can_access_portfolio_brand(uuid) to authenticated, service_role;
grant execute on function public.get_portfolio_overview() to authenticated, service_role;

insert into public.schema_releases (release_marker)
values ('20260818001000_champions_group_portfolio');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818001000_champions_group_portfolio'
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
