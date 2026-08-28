begin;

-- Historical pipeline bindings retain their original recipe lineage. Permit an
-- otherwise immutable legacy binding to transition to archived without forcing
-- it to satisfy the current catalog recipe, while rejecting any simultaneous
-- contract mutation.
create or replace function public.enforce_executive_catalog_binding_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_recipe_id text;
  expected_recipe_version integer;
  expected_window text;
  expected_comparison text;
begin
  if tg_op = 'UPDATE'
     and new.approval_status = 'archived'
     and old.approval_status is distinct from 'archived' then
    if (pg_catalog.to_jsonb(new) - array['approval_status', 'updated_at'])
       is distinct from
       (pg_catalog.to_jsonb(old) - array['approval_status', 'updated_at']) then
      raise exception 'Archiving a historical Executive binding cannot change its source contract';
    end if;
    return new;
  end if;

  select catalog.endpoint_recipe_id, catalog.endpoint_recipe_version,
         catalog.default_observation_window, catalog.default_comparison_basis
    into expected_recipe_id, expected_recipe_version, expected_window, expected_comparison
  from public.custom_kpi_definitions definition
  join public.original_kpi_catalog catalog
    on catalog.kpi_key = definition.kpi_key and catalog.catalog_version = 1
  where definition.organization_id = new.organization_id
    and definition.id = new.kpi_definition_id
    and catalog.kpi_key in (
      'pipeline', 'repair-job-volume', 'maintenance-job-volume',
      'sales-opportunity-volume', 'sales-average-ticket'
    );

  if expected_recipe_id is null then return new; end if;
  if new.source_method <> 'endpoint_recipe'
     or new.endpoint_recipe_id <> expected_recipe_id
     or new.endpoint_recipe_version <> expected_recipe_version
     or new.observation_window <> expected_window then
    raise exception 'Executive catalog binding must use its exact migration-approved endpoint recipe and observation window';
  end if;
  new.comparison_basis := expected_comparison;
  return new;
end;
$$;
revoke all on function public.enforce_executive_catalog_binding_contract() from public, anon, authenticated;

insert into public.schema_releases (release_marker)
values ('20260828000300_pipeline_binding_archive_cutover');

do $pipeline_archive_cutover_catalog$
begin
  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.enforce_executive_catalog_binding_contract()'::regprocedure
       ),
       'Archiving a historical Executive binding cannot change its source contract'
     ) = 0 then
    raise exception 'historical Executive binding archival guard is missing';
  end if;
  if not exists (
    select 1 from public.schema_releases
    where release_marker = '20260828000300_pipeline_binding_archive_cutover'
  ) then
    raise exception 'pipeline binding archive cutover release marker is missing';
  end if;
end
$pipeline_archive_cutover_catalog$;

commit;
