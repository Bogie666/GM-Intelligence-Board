begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.locations
  add column region text;

alter table public.locations
  add constraint locations_region_allowed
  check (region is null or region in ('west', 'midwest', 'northwest', 'southwest'));

create index locations_organization_region_active_idx
  on public.locations (organization_id, region, display_name)
  where status = 'active';

comment on column public.locations.region is
  'Governed operating region. Null is retained only for rolling compatibility and existing locations awaiting explicit administrator classification.';

insert into public.schema_releases (release_marker)
values ('20260819001800_location_regions');

-- Keep schema-017 application instances healthy after migration 018 is applied.
-- The schema-017 function originally selected the newest release dynamically.
create or replace function public.get_division_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.schema_releases release
      where release.release_marker = '20260819001700_tenant_managed_divisions'
    )
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
    '20260819001700_tenant_managed_divisions'::text as release_marker;
$$;
revoke all on function public.get_division_release_readiness() from public;
grant execute on function public.get_division_release_readiness() to anon, authenticated, service_role;
comment on function public.get_division_release_readiness() is
  'Schema-017 compatibility gate retained during the location-region rolling release.';

create or replace function public.get_region_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.schema_releases release
      where release.release_marker = '20260819001800_location_regions'
    )
      and (select pg_catalog.count(*) from public.original_kpi_catalog where catalog_version = 1) = 36
      and not exists (
        select 1 from public.organization_divisions division
        where pg_catalog.lower(division.name) in ('not mapped', 'unmapped')
      )
      and not exists (
        select 1 from public.locations location
        where location.region is not null
          and location.region not in ('west', 'midwest', 'northwest', 'southwest')
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
    '20260819001800_location_regions'::text as release_marker;
$$;
revoke all on function public.get_region_release_readiness() from public;
grant execute on function public.get_region_release_readiness() to anon, authenticated, service_role;
comment on function public.get_region_release_readiness() is
  'Schema-018 release gate for governed location regions. Existing null regions are an explicit tenant setup state, not a schema failure.';

commit;
