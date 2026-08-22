-- Migration: add recipe refresh policies for tranche-2 Executive recipe versions
-- completed-revenue@2, average-invoice-ticket@2, sales-close-rate@2
-- These use job-completion-date and job-opportunity bases respectively,
-- matching Lex KPI's semantics without requiring a saved report.

begin;

insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
values
  ('completed-revenue', 2, '15m'),
  ('completed-revenue', 2, '30m'),
  ('completed-revenue', 2, '1h'),
  ('completed-revenue', 2, '4h'),
  ('completed-revenue', 2, '24h'),
  ('average-invoice-ticket', 2, '30m'),
  ('average-invoice-ticket', 2, '1h'),
  ('average-invoice-ticket', 2, '4h'),
  ('average-invoice-ticket', 2, '24h'),
  ('sales-close-rate', 2, '30m'),
  ('sales-close-rate', 2, '1h'),
  ('sales-close-rate', 2, '4h'),
  ('sales-close-rate', 2, '24h');

-- Verify policies exist
do $$
begin
  if (
    select count(*) from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'completed-revenue' and endpoint_recipe_version = 2
  ) < 1 then
    raise exception 'completed-revenue v2 refresh policies not found after insert';
  end if;
  if (
    select count(*) from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'average-invoice-ticket' and endpoint_recipe_version = 2
  ) < 1 then
    raise exception 'average-invoice-ticket v2 refresh policies not found after insert';
  end if;
  if (
    select count(*) from public.service_titan_endpoint_recipe_refresh_policies
    where endpoint_recipe_id = 'sales-close-rate' and endpoint_recipe_version = 2
  ) < 1 then
    raise exception 'sales-close-rate v2 refresh policies not found after insert';
  end if;
end;
$$;

-- Flip catalog defaults to v2 for Executive recipes
update public.original_kpi_catalog
set endpoint_recipe_version = 2
where kpi_key = 'revenue-mtd'
  and endpoint_recipe_id = 'completed-revenue'
  and endpoint_recipe_version = 1;

update public.original_kpi_catalog
set endpoint_recipe_version = 2
where kpi_key = 'avg-ticket'
  and endpoint_recipe_id = 'average-invoice-ticket'
  and endpoint_recipe_version = 1;

update public.original_kpi_catalog
set endpoint_recipe_version = 2
where kpi_key = 'sales-close'
  and endpoint_recipe_id = 'sales-close-rate'
  and endpoint_recipe_version = 1;

-- Verify catalog defaults flipped
do $$
begin
  if (select endpoint_recipe_version from public.original_kpi_catalog where kpi_key = 'revenue-mtd') != 2 then
    raise exception 'revenue-mtd catalog default not flipped to v2';
  end if;
  if (select endpoint_recipe_version from public.original_kpi_catalog where kpi_key = 'avg-ticket') != 2 then
    raise exception 'avg-ticket catalog default not flipped to v2';
  end if;
  if (select endpoint_recipe_version from public.original_kpi_catalog where kpi_key = 'sales-close') != 2 then
    raise exception 'sales-close catalog default not flipped to v2';
  end if;
end;
$$;

-- Release readiness marker
insert into public.schema_releases (release_marker)
values ('20260822000000_executive_recipe_v2')
on conflict (release_marker) do nothing;

commit;