begin;

-- Immutable audit subjects are historical UUID evidence, not live profile ownership.
-- Keeping a restrictive FK would prevent an otherwise empty disposable QA identity from
-- being removed after a terminal portfolio-membership lifecycle test.
alter table public.portfolio_audit_events
  drop constraint if exists portfolio_audit_events_target_profile_id_fkey;

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
  if operation_actor_kind not in ('migration', 'service_role') or operation_actor_identifier is null then
    raise exception 'portfolio operation actor context is required' using errcode = '42501';
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

  perform 1 from public.portfolio_memberships membership
  where membership.profile_id = p_qa_user_id for update;
  if exists (
    select 1 from public.portfolio_memberships membership
    where membership.profile_id = p_qa_user_id
      and (membership.portfolio_id <> p_portfolio_id or membership.status <> 'revoked')
  ) then
    raise exception 'QA owner has an active or unrelated portfolio membership' using errcode = '23514';
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
  perform pg_catalog.set_config('app.qa_teardown_user_id', p_qa_user_id::text, true);
  perform pg_catalog.set_config('app.portfolio_operation_reason', btrim(p_reason), true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_kind', 'service_role', true);
  perform pg_catalog.set_config('app.portfolio_operation_actor_identifier', 'prepare_empty_qa_brand_removal', true);
  delete from public.portfolio_organizations attachment
  where attachment.portfolio_id = p_portfolio_id and attachment.organization_id = p_organization_id;
  if p_qa_user_id <> p_platform_owner_profile_id then
    delete from public.organization_memberships membership
    where membership.organization_id = p_organization_id and membership.profile_id = p_platform_owner_profile_id;
  end if;
  delete from public.portfolio_memberships membership
  where membership.portfolio_id = p_portfolio_id
    and membership.profile_id = p_qa_user_id
    and membership.status = 'revoked';
  return true;
end;
$$;

insert into public.schema_releases (release_marker)
values ('20260818001200_atomic_qa_portfolio_cleanup');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818001200_atomic_qa_portfolio_cleanup'
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
