-- Migration: publish timezone-aware membership event recipes v2.
--
-- v1 mixed record creation timestamps, cancellation-only status filters, and
-- modified-record queries. That overstated new memberships, omitted natural
-- expirations, and made New - Churn differ from Net Growth. V2 uses the complete
-- bounded membership inventory and local membership event dates:
--   new membership = local `from` date in the observed period
--   effective end  = earliest(local cancellationDate, local expiration `to`)
--   net growth     = new membership events - effective-end events
-- Future-dated events are excluded by the worker period end. V1 remains for
-- immutable historical lineage but cannot be newly selected or approved.

begin;

update public.service_titan_endpoint_recipe_refresh_policies
set selectable_for_new_bindings = false
where endpoint_recipe_id in ('new-memberships', 'canceled-memberships', 'membership-net-growth')
  and endpoint_recipe_version = 1;

insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval, selectable_for_new_bindings)
values
  ('new-memberships', 2, '1h', true),
  ('new-memberships', 2, '4h', true),
  ('new-memberships', 2, '24h', true),
  ('canceled-memberships', 2, '1h', true),
  ('canceled-memberships', 2, '4h', true),
  ('canceled-memberships', 2, '24h', true),
  ('membership-net-growth', 2, '1h', true),
  ('membership-net-growth', 2, '4h', true),
  ('membership-net-growth', 2, '24h', true);

update public.original_kpi_catalog
set endpoint_recipe_version = case kpi_key
  when 'new-members' then 2
  when 'member-cancels' then 2
  when 'membership-net' then 2
  else endpoint_recipe_version
end
where catalog_version = 1
  and (kpi_key, endpoint_recipe_id, endpoint_recipe_version) in (
    ('new-members', 'new-memberships', 1),
    ('member-cancels', 'canceled-memberships', 1),
    ('membership-net', 'membership-net-growth', 1)
  );

do $$
declare
  v_recipe text;
begin
  foreach v_recipe in array array['new-memberships', 'canceled-memberships', 'membership-net-growth'] loop
    if (
      select pg_catalog.count(*)
      from public.service_titan_endpoint_recipe_refresh_policies
      where endpoint_recipe_id = v_recipe
        and endpoint_recipe_version = 2
        and selectable_for_new_bindings
        and refresh_interval in ('1h', '4h', '24h')
    ) <> 3 or exists (
      select 1
      from public.service_titan_endpoint_recipe_refresh_policies
      where endpoint_recipe_id = v_recipe
        and endpoint_recipe_version = 2
        and refresh_interval not in ('1h', '4h', '24h')
    ) then
      raise exception '% v2 refresh policy contract is incomplete', v_recipe;
    end if;

    if exists (
      select 1
      from public.service_titan_endpoint_recipe_refresh_policies
      where endpoint_recipe_id = v_recipe
        and endpoint_recipe_version = 1
        and selectable_for_new_bindings
    ) or not exists (
      select 1
      from public.service_titan_endpoint_recipe_refresh_policies
      where endpoint_recipe_id = v_recipe
        and endpoint_recipe_version = 1
    ) then
      raise exception '% v1 historical policy was not retired safely', v_recipe;
    end if;
  end loop;

  if not exists (
    select 1 from public.original_kpi_catalog
    where catalog_version = 1 and kpi_key = 'new-members'
      and endpoint_recipe_id = 'new-memberships' and endpoint_recipe_version = 2
  ) or not exists (
    select 1 from public.original_kpi_catalog
    where catalog_version = 1 and kpi_key = 'member-cancels'
      and endpoint_recipe_id = 'canceled-memberships' and endpoint_recipe_version = 2
  ) or not exists (
    select 1 from public.original_kpi_catalog
    where catalog_version = 1 and kpi_key = 'membership-net'
      and endpoint_recipe_id = 'membership-net-growth' and endpoint_recipe_version = 2
  ) then
    raise exception 'membership catalog defaults were not advanced to v2';
  end if;
end;
$$;

-- Tranche-1 readiness follows the current authoritative membership recipe.
create or replace function public.get_tranche1_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select pg_catalog.count(*) from public.original_kpi_catalog
     where catalog_version = 1 and endpoint_recipe_id is not null) = 23
      and exists (
        select 1 from public.original_kpi_catalog
        where catalog_version = 1 and kpi_key = 'booking-rate'
          and endpoint_recipe_id = 'inbound-call-booking-rate' and endpoint_recipe_version = 3
      )
      and exists (
        select 1 from public.original_kpi_catalog
        where catalog_version = 1 and kpi_key = 'ytd-revenue'
          and default_observation_window = 'ytd'
      )
      and exists (
        select 1 from public.service_titan_endpoint_recipe_refresh_policies
        where endpoint_recipe_id = 'membership-net-growth' and endpoint_recipe_version = 2
          and selectable_for_new_bindings
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260822000200_membership_event_recipes_v2'
      ) as ready,
    '20260822000200_membership_event_recipes_v2'::text as release_marker;
$$;
revoke all on function public.get_tranche1_release_readiness() from public;
grant execute on function public.get_tranche1_release_readiness() to anon, authenticated, service_role;

insert into public.schema_releases (release_marker)
values ('20260822000200_membership_event_recipes_v2');

create or replace function public.get_membership_event_v2_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists (
      select 1
      from public.service_titan_endpoint_recipe_refresh_policies
      where endpoint_recipe_id in ('new-memberships', 'canceled-memberships', 'membership-net-growth')
        and endpoint_recipe_version = 1
        and selectable_for_new_bindings
    )
      and (select pg_catalog.count(*)
           from public.service_titan_endpoint_recipe_refresh_policies
           where endpoint_recipe_id in ('new-memberships', 'canceled-memberships', 'membership-net-growth')
             and endpoint_recipe_version = 2
             and selectable_for_new_bindings
             and refresh_interval in ('1h', '4h', '24h')) = 9
      and (select pg_catalog.count(*)
           from public.original_kpi_catalog
           where catalog_version = 1
             and (kpi_key, endpoint_recipe_id, endpoint_recipe_version) in (
               ('new-members', 'new-memberships', 2),
               ('member-cancels', 'canceled-memberships', 2),
               ('membership-net', 'membership-net-growth', 2)
             )) = 3
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260822000200_membership_event_recipes_v2'
      ) as ready,
    '20260822000200_membership_event_recipes_v2'::text as release_marker;
$$;
revoke all on function public.get_membership_event_v2_release_readiness() from public;
grant execute on function public.get_membership_event_v2_release_readiness() to anon, authenticated, service_role;

commit;
