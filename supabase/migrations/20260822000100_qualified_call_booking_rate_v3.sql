-- Migration: publish ServiceTitan-qualified inbound call booking rate v3.
--
-- v2 used all returned Telecom rows and relied on an unsupported direction
-- query parameter. v3 preserves v2 for historical lineage and introduces the
-- ServiceTitan dashboard basis:
--   booked jobs from qualified inbound call leads / qualified inbound call leads
-- The trusted worker owns the reducer semantics. This migration publishes the
-- cadence contract, retires v1/v2 from new or newly approved bindings at the
-- database boundary, and changes the catalog default. Existing approved v1/v2
-- bindings remain immutable, archivable, and executable for historical lineage.

begin;

alter table public.service_titan_endpoint_recipe_refresh_policies
  add column selectable_for_new_bindings boolean not null default true;

comment on column public.service_titan_endpoint_recipe_refresh_policies.selectable_for_new_bindings is
  'False preserves historical execution/cadence contracts while blocking new or newly approved bindings.';

update public.service_titan_endpoint_recipe_refresh_policies
set selectable_for_new_bindings = false
where endpoint_recipe_id = 'inbound-call-booking-rate'
  and endpoint_recipe_version in (1, 2);

insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval, selectable_for_new_bindings)
values
  ('inbound-call-booking-rate', 3, '15m', true),
  ('inbound-call-booking-rate', 3, '30m', true),
  ('inbound-call-booking-rate', 3, '1h', true),
  ('inbound-call-booking-rate', 3, '4h', true);

update public.original_kpi_catalog
set endpoint_recipe_version = 3
where catalog_version = 1
  and kpi_key = 'booking-rate'
  and endpoint_recipe_id = 'inbound-call-booking-rate'
  and endpoint_recipe_version = 2;

create or replace function public.enforce_endpoint_recipe_selectability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requires_selectable boolean := false;
begin
  if new.source_method is distinct from 'endpoint_recipe' then
    return new;
  end if;

  if pg_catalog.upper(tg_op) = 'INSERT' then
    v_requires_selectable := true;
  elsif pg_catalog.upper(tg_op) = 'UPDATE' then
    v_requires_selectable := old.source_method is distinct from new.source_method
      or old.endpoint_recipe_id is distinct from new.endpoint_recipe_id
      or old.endpoint_recipe_version is distinct from new.endpoint_recipe_version
      or (new.approval_status = 'approved' and old.approval_status is distinct from 'approved');
  end if;

  if v_requires_selectable and not exists (
    select 1
    from public.service_titan_endpoint_recipe_refresh_policies policy
    where policy.endpoint_recipe_id = new.endpoint_recipe_id
      and policy.endpoint_recipe_version = new.endpoint_recipe_version
      and policy.selectable_for_new_bindings
  ) then
    raise exception 'Endpoint recipe % version % is retired and cannot be used for a new or newly approved binding',
      new.endpoint_recipe_id, new.endpoint_recipe_version;
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_endpoint_recipe_selectability() from public, anon, authenticated;

drop trigger if exists enforce_endpoint_recipe_selectability on public.custom_kpi_location_bindings;
create trigger enforce_endpoint_recipe_selectability
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.enforce_endpoint_recipe_selectability();

do $$
begin
  if (
    select pg_catalog.count(*)
    from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'inbound-call-booking-rate'
      and endpoint_recipe_version = 3
      and selectable_for_new_bindings
      and refresh_interval in ('15m', '30m', '1h', '4h')
  ) <> 4 or exists (
    select 1
    from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'inbound-call-booking-rate'
      and endpoint_recipe_version = 3
      and refresh_interval not in ('15m', '30m', '1h', '4h')
  ) then
    raise exception 'inbound-call-booking-rate v3 refresh policy contract is incomplete';
  end if;

  if exists (
    select 1
    from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'inbound-call-booking-rate'
      and endpoint_recipe_version in (1, 2)
      and selectable_for_new_bindings
  ) or (
    select pg_catalog.count(distinct endpoint_recipe_version)
    from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'inbound-call-booking-rate'
      and endpoint_recipe_version in (1, 2)
  ) <> 2 then
    raise exception 'inbound-call-booking-rate historical versions were not retired safely';
  end if;

  if not exists (
    select 1
    from public.original_kpi_catalog
    where catalog_version = 1
      and kpi_key = 'booking-rate'
      and endpoint_recipe_id = 'inbound-call-booking-rate'
      and endpoint_recipe_version = 3
  ) then
    raise exception 'booking-rate catalog default was not advanced to recipe v3';
  end if;
end;
$$;

-- Tranche-1 readiness follows the current authoritative catalog recipe version.
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
        where endpoint_recipe_id = 'membership-net-growth' and endpoint_recipe_version = 1
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260821000100_tranche1_catalog_recipes'
      ) as ready,
    '20260821000100_tranche1_catalog_recipes'::text as release_marker;
$$;
revoke all on function public.get_tranche1_release_readiness() from public;
grant execute on function public.get_tranche1_release_readiness() to anon, authenticated, service_role;

insert into public.schema_releases (release_marker)
values ('20260822000100_qualified_call_booking_rate_v3');

create or replace function public.get_booking_rate_v3_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.original_kpi_catalog
      where catalog_version = 1 and kpi_key = 'booking-rate'
        and endpoint_recipe_id = 'inbound-call-booking-rate' and endpoint_recipe_version = 3
    )
      and (select pg_catalog.count(*)
           from public.service_titan_endpoint_recipe_refresh_policies
           where endpoint_recipe_id = 'inbound-call-booking-rate'
             and endpoint_recipe_version = 3
             and selectable_for_new_bindings
             and refresh_interval in ('15m', '30m', '1h', '4h')) = 4
      and not exists (
        select 1 from public.service_titan_endpoint_recipe_refresh_policies
        where endpoint_recipe_id = 'inbound-call-booking-rate'
          and endpoint_recipe_version = 3
          and refresh_interval not in ('15m', '30m', '1h', '4h')
      )
      and not exists (
        select 1 from public.service_titan_endpoint_recipe_refresh_policies
        where endpoint_recipe_id = 'inbound-call-booking-rate'
          and endpoint_recipe_version in (1, 2)
          and selectable_for_new_bindings
      )
      and (select pg_catalog.count(distinct endpoint_recipe_version)
           from public.service_titan_endpoint_recipe_refresh_policies
           where endpoint_recipe_id = 'inbound-call-booking-rate'
             and endpoint_recipe_version in (1, 2)) = 2
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260822000100_qualified_call_booking_rate_v3'
      ) as ready,
    '20260822000100_qualified_call_booking_rate_v3'::text as release_marker;
$$;
revoke all on function public.get_booking_rate_v3_release_readiness() from public;
grant execute on function public.get_booking_rate_v3_release_readiness() to anon, authenticated, service_role;

commit;
