begin;

-- ---------------------------------------------------------------------------
-- Portfolio brand onboarding (in-app organization creation)
--
-- Adds one authenticated-executable, security-definer RPC that lets an ACTIVE
-- PORTFOLIO OWNER create a new brand organization from the application:
--   1. creates the organization,
--   2. grants organization memberships to every active portfolio member
--      (role-mapped) so portfolio coverage invariants keep holding,
--   3. attaches the brand to the owner's portfolio,
--   4. writes portfolio + configuration audit events.
-- Everything happens in one transaction and fails closed. Organization-level
-- admins and non-owner portfolio members cannot execute the mutation.
-- ---------------------------------------------------------------------------

-- The portfolio audit trail gains a first-class actor kind for owner-driven
-- onboarding, so audit rows tell the truth instead of masquerading as
-- service_role activity.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.portfolio_audit_events'::pg_catalog.regclass
      and conname = 'portfolio_audit_events_actor_kind_check'
  ) then
    raise exception 'expected constraint portfolio_audit_events_actor_kind_check is missing';
  end if;
end;
$$;

alter table public.portfolio_audit_events
  drop constraint portfolio_audit_events_actor_kind_check;
alter table public.portfolio_audit_events
  add constraint portfolio_audit_events_actor_kind_check
  check (actor_kind in ('migration', 'service_role', 'portfolio_owner'));

-- The configuration audit trail's actor-membership FK must be checked at commit
-- time so a single governed transaction can create an organization (audit row
-- fires immediately) and then grant the acting owner's membership. NO ACTION at
-- commit provides the same integrity guarantee RESTRICT provided immediately.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.audit_events'::pg_catalog.regclass
      and conname = 'audit_events_actor_membership_fk'
  ) then
    raise exception 'expected constraint audit_events_actor_membership_fk is missing';
  end if;
end;
$$;

alter table public.audit_events
  drop constraint audit_events_actor_membership_fk;
alter table public.audit_events
  add constraint audit_events_actor_membership_fk
  foreign key (organization_id, actor_profile_id)
  references public.organization_memberships (organization_id, profile_id)
  on delete no action
  deferrable initially deferred;

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
  qa_teardown_user_id text := nullif(btrim(pg_catalog.current_setting('app.qa_teardown_user_id', true)), '');
begin
  before_row := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_row := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  if tg_op = 'DELETE' and not (
    (
      tg_table_name = 'portfolio_organizations'
      and operation_actor_identifier = 'prepare_empty_qa_brand_removal'
    ) or (
      tg_table_name = 'portfolio_memberships'
      and operation_actor_identifier = 'prepare_empty_qa_brand_removal'
      and qa_teardown_user_id is not null
      and before_row ->> 'profile_id' = qa_teardown_user_id
      and before_row ->> 'status' = 'revoked'
    )
  ) then
    raise exception 'portfolio governance records use lifecycle status transitions, not deletes' using errcode = '42501';
  end if;
  if operation_reason is null or length(operation_reason) < 3 then
    raise exception 'portfolio operation reason is required' using errcode = '42501';
  end if;
  if operation_actor_kind not in ('migration', 'service_role', 'portfolio_owner') or operation_actor_identifier is null then
    raise exception 'portfolio operation actor context is required' using errcode = '42501';
  end if;
  if operation_actor_kind = 'portfolio_owner'
     and operation_actor_identifier <> 'create_portfolio_brand_organization' then
    raise exception 'portfolio owner mutations are limited to governed onboarding' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if tg_table_name = 'portfolios' and before_row ->> 'id' is distinct from after_row ->> 'id' then
      raise exception 'portfolio identity is immutable' using errcode = '23514';
    elsif tg_table_name = 'portfolio_memberships' and (
      before_row ->> 'id' is distinct from after_row ->> 'id'
      or before_row ->> 'portfolio_id' is distinct from after_row ->> 'portfolio_id'
      or before_row ->> 'profile_id' is distinct from after_row ->> 'profile_id'
    ) then
      raise exception 'portfolio membership identity is immutable' using errcode = '23514';
    elsif tg_table_name = 'portfolio_organizations' and (
      before_row ->> 'id' is distinct from after_row ->> 'id'
      or before_row ->> 'portfolio_id' is distinct from after_row ->> 'portfolio_id'
      or before_row ->> 'organization_id' is distinct from after_row ->> 'organization_id'
    ) then
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

-- ---------------------------------------------------------------------------
-- Owner-only visibility helper for the application UI. Mirrors the exact
-- authorization rule enforced by create_portfolio_brand_organization: the
-- caller must hold exactly one active portfolio membership and it must be the
-- owner role on an active portfolio.
-- ---------------------------------------------------------------------------

create or replace function public.is_portfolio_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then false else coalesce((
    select pg_catalog.count(*) = 1 and pg_catalog.bool_and(membership.role = 'owner')
    from public.portfolio_memberships membership
    join public.portfolios portfolio on portfolio.id = membership.portfolio_id
    where membership.profile_id = auth.uid()
      and membership.status = 'active'
      and portfolio.status = 'active'
  ), false) end;
$$;

revoke all on function public.is_portfolio_owner() from public, anon;
grant execute on function public.is_portfolio_owner() to authenticated, service_role;
comment on function public.is_portfolio_owner() is
  'Read-only UI gate: true only when the caller holds exactly one active portfolio membership and that membership is the owner role.';

-- ---------------------------------------------------------------------------
-- Owner-governed brand onboarding RPC
-- ---------------------------------------------------------------------------

create or replace function public.create_portfolio_brand_organization(
  p_organization_slug text,
  p_organization_name text
)
returns table (
  organization_id uuid,
  membership_id uuid,
  attachment_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_profile_id uuid := auth.uid();
  normalized_slug text := pg_catalog.lower(pg_catalog.btrim(p_organization_slug));
  normalized_name text := pg_catalog.btrim(p_organization_name);
  caller_portfolio_id uuid;
  caller_portfolio_role text;
  caller_portfolio_membership_count integer;
  next_sort_order integer;
  new_organization_id uuid;
  caller_membership_id uuid;
  new_attachment_id uuid;
begin
  if caller_profile_id is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated portfolio owner authorization is required' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer
  into caller_portfolio_membership_count
  from public.portfolio_memberships membership
  join public.portfolios portfolio on portfolio.id = membership.portfolio_id
  where membership.profile_id = caller_profile_id
    and membership.status = 'active'
    and portfolio.status = 'active';
  if caller_portfolio_membership_count <> 1 then
    raise exception 'exactly one active portfolio membership is required' using errcode = '42501';
  end if;

  select membership.portfolio_id, membership.role
  into caller_portfolio_id, caller_portfolio_role
  from public.portfolio_memberships membership
  join public.portfolios portfolio on portfolio.id = membership.portfolio_id
  where membership.profile_id = caller_profile_id
    and membership.status = 'active'
    and portfolio.status = 'active';
  if caller_portfolio_role is distinct from 'owner' then
    raise exception 'only the portfolio owner can create brand organizations' using errcode = '42501';
  end if;

  if normalized_slug is null or normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' then
    raise exception 'organization slug must be 3-64 lowercase letters, numbers, or hyphens' using errcode = '22023';
  end if;
  if normalized_name is null
     or pg_catalog.length(normalized_name) < 2
     or pg_catalog.length(normalized_name) > 160 then
    raise exception 'organization name must contain 2 to 160 characters' using errcode = '22023';
  end if;

  -- Serialize concurrent onboarding of the same slug; the unique constraint
  -- stays the authoritative backstop.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('gmib-bootstrap-slug:' || normalized_slug, 0)
  );
  perform 1 from public.portfolios portfolio where portfolio.id = caller_portfolio_id for update;

  if exists (select 1 from public.organizations organization where organization.slug = normalized_slug) then
    raise exception 'organization slug is already in use' using errcode = '23505';
  end if;

  insert into public.organizations (slug, name, status)
  values (normalized_slug, normalized_name, 'active')
  returning id into new_organization_id;

  -- Every active portfolio member receives a role-mapped membership in the new
  -- brand so portfolio-wide coverage invariants (overview, readiness) hold for
  -- every member, not only the caller.
  insert into public.organization_memberships (organization_id, profile_id, role, status, joined_at)
  select
    new_organization_id,
    membership.profile_id,
    case membership.role
      when 'owner' then 'owner'
      when 'admin' then 'admin'
      else 'viewer'
    end,
    'active',
    pg_catalog.now()
  from public.portfolio_memberships membership
  where membership.portfolio_id = caller_portfolio_id
    and membership.status = 'active';

  select membership.id
  into caller_membership_id
  from public.organization_memberships membership
  where membership.organization_id = new_organization_id
    and membership.profile_id = caller_profile_id
    and membership.role = 'owner'
    and membership.status = 'active';
  if caller_membership_id is null then
    raise exception 'brand owner membership was not established' using errcode = '23514';
  end if;

  select coalesce(pg_catalog.max(attachment.sort_order), 0) + 10
  into next_sort_order
  from public.portfolio_organizations attachment
  where attachment.portfolio_id = caller_portfolio_id;

  perform pg_catalog.set_config(
    'app.portfolio_operation_reason',
    'Portfolio owner onboarded brand ' || normalized_slug || ' from the Admin application',
    true
  );
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'portfolio_owner', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'create_portfolio_brand_organization', true);
  insert into public.portfolio_organizations (portfolio_id, organization_id, status, sort_order)
  values (caller_portfolio_id, new_organization_id, 'active', least(next_sort_order, 100000))
  returning id into new_attachment_id;
  perform pg_catalog.set_config('app.portfolio_operation_reason', '', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', '', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', '', true);

  return query select new_organization_id, caller_membership_id, new_attachment_id;
end;
$$;

revoke all on function public.create_portfolio_brand_organization(text, text) from public, anon;
grant execute on function public.create_portfolio_brand_organization(text, text) to authenticated, service_role;
comment on function public.create_portfolio_brand_organization(text, text) is
  'Authenticated portfolio-owner RPC that atomically creates a brand organization, grants role-mapped memberships to every active portfolio member, and attaches the brand to the caller''s portfolio with full audit context.';

insert into public.schema_releases (release_marker)
values ('20260820002300_portfolio_brand_onboarding');

create or replace function public.get_portfolio_onboarding_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_catalog.to_regprocedure('public.create_portfolio_brand_organization(text,text)') is not null
      and pg_catalog.to_regprocedure('public.is_portfolio_owner()') is not null
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002300_portfolio_brand_onboarding'
      ) as ready,
    '20260820002300_portfolio_brand_onboarding'::text as release_marker;
$$;
revoke all on function public.get_portfolio_onboarding_release_readiness() from public;
grant execute on function public.get_portfolio_onboarding_release_readiness() to anon, authenticated, service_role;

commit;
