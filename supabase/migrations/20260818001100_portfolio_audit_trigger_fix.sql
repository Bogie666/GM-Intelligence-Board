begin;

-- Trigger records are table-shaped at runtime. Compare immutable identity through the
-- already-materialized JSON snapshots so a portfolio membership update never resolves
-- organization_id (which only exists on portfolio_organizations), and vice versa.
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

insert into public.schema_releases (release_marker)
values ('20260818001100_portfolio_audit_trigger_fix');

create or replace function public.get_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    marker.release_marker = '20260818001100_portfolio_audit_trigger_fix'
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
