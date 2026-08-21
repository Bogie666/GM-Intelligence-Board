begin;

-- ---------------------------------------------------------------------------
-- Tranche-1 catalog activation: seven new governed endpoint recipes, a
-- year-to-date observation window, and wiring for nine additional original-
-- catalog KPIs.
--
-- 1. Adds the 'ytd' observation window (location-local January 1 → now) to
--    the binding and catalog window constraints.
-- 2. Registers refresh policies for the new recipe contracts implemented in
--    the trusted worker:
--      inbound-calls-count@1          non-abandoned inbound call count
--      inbound-call-booking-rate@2    job-number booking semantics (v1's
--                                     callType=Booked never matches this
--                                     tenant; v2 = booked/(non-abandoned))
--      new-memberships@1              memberships created in period
--      canceled-memberships@1         cancellationDate windowed client-side
--      membership-net-growth@1        created minus canceled in period
--      sold-estimates-value@1         sold estimate subtotal in period
--      jobs-with-appointments-count@1 jobs with an appointment starting in
--                                     period (department scoping via BUs)
-- 3. Wires the nine catalog KPIs with calendar-appropriate default windows.
-- 4. Extends release readiness for the tranche.
-- ---------------------------------------------------------------------------

alter table public.custom_kpi_location_bindings
  drop constraint custom_kpi_location_bindings_observation_window_check;
alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_location_bindings_observation_window_check
  check (observation_window in ('trailing', 'today', 'mtd', 'ytd'));

alter table public.original_kpi_catalog
  drop constraint original_kpi_catalog_default_observation_window_check;
alter table public.original_kpi_catalog
  add constraint original_kpi_catalog_default_observation_window_check
  check (default_observation_window in ('trailing', 'today', 'mtd', 'ytd'));

-- New recipe refresh policies.
insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
values
  ('inbound-calls-count', 1, '15m'),
  ('inbound-calls-count', 1, '30m'),
  ('inbound-calls-count', 1, '1h'),
  ('inbound-calls-count', 1, '4h'),
  ('inbound-call-booking-rate', 2, '15m'),
  ('inbound-call-booking-rate', 2, '30m'),
  ('inbound-call-booking-rate', 2, '1h'),
  ('inbound-call-booking-rate', 2, '4h'),
  ('new-memberships', 1, '1h'),
  ('new-memberships', 1, '4h'),
  ('new-memberships', 1, '24h'),
  ('canceled-memberships', 1, '1h'),
  ('canceled-memberships', 1, '4h'),
  ('canceled-memberships', 1, '24h'),
  ('membership-net-growth', 1, '1h'),
  ('membership-net-growth', 1, '4h'),
  ('membership-net-growth', 1, '24h'),
  ('sold-estimates-value', 1, '30m'),
  ('sold-estimates-value', 1, '1h'),
  ('sold-estimates-value', 1, '4h'),
  ('sold-estimates-value', 1, '24h'),
  ('jobs-with-appointments-count', 1, '30m'),
  ('jobs-with-appointments-count', 1, '1h'),
  ('jobs-with-appointments-count', 1, '4h'),
  ('jobs-with-appointments-count', 1, '24h')
on conflict do nothing;

-- Wire the nine tranche-1 KPIs. booking-rate moves from the tenant-broken v1
-- contract to v2; every other KPI gains its first recipe.
update public.original_kpi_catalog
set endpoint_recipe_id = wiring.recipe_id,
    endpoint_recipe_version = wiring.recipe_version,
    default_observation_window = wiring.obs_window
from (
  values
    ('ytd-revenue', 'completed-revenue', 1, 'ytd'),
    ('inbound-calls', 'inbound-calls-count', 1, 'today'),
    ('booking-rate', 'inbound-call-booking-rate', 2, 'today'),
    ('new-members', 'new-memberships', 1, 'mtd'),
    ('member-cancels', 'canceled-memberships', 1, 'mtd'),
    ('membership-net', 'membership-net-growth', 1, 'mtd'),
    ('pipeline', 'sold-estimates-value', 1, 'mtd'),
    ('hvac-sales-appts', 'jobs-with-appointments-count', 1, 'today'),
    ('plumbing-appts', 'jobs-with-appointments-count', 1, 'today')
) as wiring(kpi_key, recipe_id, recipe_version, obs_window)
where original_kpi_catalog.catalog_version = 1
  and original_kpi_catalog.kpi_key = wiring.kpi_key;

-- Migration 025's readiness gate pinned exact catalog window counts (10 mtd /
-- 4 today). Tranche 1 moves them to 14 mtd / 7 today / 1 ytd, so the gate is
-- redefined with the new authoritative distribution.
create or replace function public.get_observation_window_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'custom_kpi_location_bindings'
        and column_name = 'observation_window'
    )
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'original_kpi_catalog'
          and column_name = 'default_observation_window'
      )
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and default_observation_window = 'mtd') = 14
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and default_observation_window = 'today') = 7
      and (select pg_catalog.count(*) from public.original_kpi_catalog
           where catalog_version = 1 and default_observation_window = 'ytd') = 1
      and exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public'
          and indexname = 'custom_kpi_binding_exact_location_active_unique'
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002500_binding_observation_windows'
      ) as ready,
    '20260820002500_binding_observation_windows'::text as release_marker;
$$;
revoke all on function public.get_observation_window_release_readiness() from public;
grant execute on function public.get_observation_window_release_readiness() to anon, authenticated, service_role;

insert into public.schema_releases (release_marker)
values ('20260821000100_tranche1_catalog_recipes');

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
          and endpoint_recipe_id = 'inbound-call-booking-rate' and endpoint_recipe_version = 2
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

commit;
