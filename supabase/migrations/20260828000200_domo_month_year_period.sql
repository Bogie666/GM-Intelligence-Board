begin;

-- Portfolio-safe Domo monthly contracts. The organization-scoped source owns
-- its mapped brand/location filter; no provider value is hard-coded in app or SQL.
alter table public.domo_dataset_sources
  add column period_mode text,
  add column month_column text,
  add column year_column text,
  add column expected_period_rows integer;

alter table public.domo_dataset_sources disable trigger domo_dataset_sources_05_protect;
update public.domo_dataset_sources
set period_mode = case when date_column is null then 'none' else 'date' end;
alter table public.domo_dataset_sources enable trigger domo_dataset_sources_05_protect;

alter table public.domo_dataset_sources
  drop constraint if exists domo_dataset_sources_latest_requires_date,
  alter column period_mode set not null,
  alter column period_mode set default 'none',
  add constraint domo_dataset_sources_period_mode_check
    check (period_mode in ('none', 'date', 'month_year')),
  add constraint domo_dataset_sources_period_shape check (
    (period_mode = 'none' and date_column is null and month_column is null and year_column is null)
    or (period_mode = 'date' and date_column is not null and month_column is null and year_column is null)
    or (period_mode = 'month_year' and date_column is null and month_column is not null and year_column is not null)
  ),
  add constraint domo_dataset_sources_month_year_mapped_filter check (
    period_mode <> 'month_year' or (filter_column is not null and filter_value is not null)
  ),
  add constraint domo_dataset_sources_latest_requires_period check (
    reduction <> 'latest' or period_mode in ('date', 'month_year')
  ),
  add constraint domo_dataset_sources_month_column_shape check (
    month_column is null or month_column ~ '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$'
  ),
  add constraint domo_dataset_sources_year_column_shape check (
    year_column is null or year_column ~ '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$'
  ),
  add constraint domo_dataset_sources_expected_period_rows_check check (
    expected_period_rows is null or expected_period_rows between 1 and 250000
  );

comment on column public.domo_dataset_sources.period_mode is
  'none, date, or month_year. month_year uses the binding location timezone and requires an explicit organization-owned mapped filter.';
comment on column public.domo_dataset_sources.expected_period_rows is
  'Optional approved row cardinality after mapped filter and observation-period filtering; mismatches fail closed.';

-- Preserve every legacy digest exactly. New month/year identity is appended only
-- for the new contract shape; expected cardinality is appended only when declared.
create or replace function public.set_domo_dataset_source_fingerprint()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract jsonb;
begin
  v_contract := pg_catalog.jsonb_build_object(
    'organizationId', new.organization_id,
    'domoConnectionId', new.domo_connection_id,
    'datasetId', new.dataset_id,
    'valueColumn', new.value_column,
    'reduction', new.reduction,
    'dateColumn', new.date_column,
    'filterColumn', new.filter_column,
    'filterValue', new.filter_value
  );
  if new.period_mode = 'month_year' then
    v_contract := v_contract || pg_catalog.jsonb_build_object(
      'periodMode', new.period_mode,
      'monthColumn', new.month_column,
      'yearColumn', new.year_column
    );
  end if;
  if new.expected_period_rows is not null then
    v_contract := v_contract || pg_catalog.jsonb_build_object(
      'expectedPeriodRows', new.expected_period_rows
    );
  end if;
  new.canonical_source_fingerprint := public.canonical_source_fingerprint(v_contract);
  return new;
end;
$$;
revoke all on function public.set_domo_dataset_source_fingerprint() from public, anon, authenticated;

-- Replace the browser RPC instead of overloading it so stale callers fail closed.
drop function if exists public.create_domo_dataset_source(
  uuid, uuid, text, text, text, text, text, text, text, text
);
create function public.create_domo_dataset_source(
  p_organization_id uuid,
  p_domo_connection_id uuid,
  p_dataset_id text,
  p_name text,
  p_description text,
  p_value_column text,
  p_reduction text,
  p_period_mode text,
  p_date_column text,
  p_month_column text,
  p_year_column text,
  p_filter_column text,
  p_filter_value text,
  p_expected_period_rows integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_source_id uuid;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'authenticated tenant administrator required' using errcode = '42501';
  end if;

  select membership.role into v_actor_role
  from public.organization_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id and organization.status = 'active'
  where membership.organization_id = p_organization_id
    and membership.profile_id = auth.uid()
    and membership.status = 'active';
  if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
    raise exception 'active tenant owner or admin required' using errcode = '42501';
  end if;

  perform 1
  from public.domo_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_domo_connection_id
    and connection.status in ('needs_attention', 'ready')
  for share;
  if not found then
    raise exception 'exact enabled Domo connection required' using errcode = '22023';
  end if;

  insert into public.domo_dataset_sources (
    organization_id, domo_connection_id, dataset_id, name, description,
    value_column, reduction, period_mode, date_column, month_column, year_column,
    filter_column, filter_value, expected_period_rows,
    lifecycle, status, created_by
  ) values (
    p_organization_id, p_domo_connection_id,
    pg_catalog.lower(pg_catalog.btrim(p_dataset_id)), pg_catalog.btrim(p_name),
    coalesce(p_description, ''), p_value_column, p_reduction, p_period_mode,
    p_date_column, p_month_column, p_year_column, p_filter_column, p_filter_value,
    p_expected_period_rows, 'draft', 'active', auth.uid()
  ) returning id into v_source_id;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  )
  select
    source.organization_id, auth.uid(), 'domo.dataset_source.create',
    'domo_dataset_sources', source.id, null,
    pg_catalog.jsonb_build_object(
      'lifecycle', source.lifecycle,
      'status', source.status,
      'sourceFingerprint', source.canonical_source_fingerprint,
      'periodMode', source.period_mode,
      'mappedFilterColumn', source.filter_column
    ),
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  from public.domo_dataset_sources source
  where source.id = v_source_id;

  return v_source_id;
end;
$$;
revoke all on function public.create_domo_dataset_source(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, integer
) from public, anon, service_role;
grant execute on function public.create_domo_dataset_source(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, integer
) to authenticated;

insert into public.schema_releases (release_marker)
values ('20260828000200_domo_month_year_period');

create or replace function public.get_data_platform_release_readiness()
returns table (ready boolean, release_marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pg_catalog.to_regclass('public.service_titan_endpoint_ingestion_runs') is not null
      and pg_catalog.to_regclass('public.service_titan_custom_endpoint_sources') is not null
      and pg_catalog.to_regclass('public.domo_connections') is not null
      and pg_catalog.to_regclass('public.domo_dataset_sources') is not null
      and pg_catalog.to_regprocedure('public.create_service_titan_custom_endpoint_source(uuid,uuid,text,text,text,text,jsonb,text,text,text)') is not null
      and pg_catalog.to_regprocedure('public.archive_service_titan_custom_endpoint_source(uuid,uuid,integer)') is not null
      and pg_catalog.to_regprocedure('public.inspect_service_titan_custom_endpoint_source(uuid,uuid,text)') is not null
      and pg_catalog.to_regprocedure('public.create_domo_dataset_source(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer)') is not null
      and pg_catalog.to_regprocedure('public.archive_domo_dataset_source(uuid,uuid,integer)') is not null
      and pg_catalog.to_regprocedure('public.disable_domo_connection(uuid,uuid,integer,integer)') is not null
      and pg_catalog.to_regprocedure('public.inspect_domo_dataset_source(uuid,uuid,text)') is not null
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002200_data_source_admin_hardening'
      )
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260828000200_domo_month_year_period'
      ) as ready,
    '20260828000200_domo_month_year_period'::text as release_marker;
$$;
revoke all on function public.get_data_platform_release_readiness() from public;
grant execute on function public.get_data_platform_release_readiness() to anon, authenticated, service_role;

-- Transactional smoke checks.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.domo_dataset_sources'::regclass
      and conname = 'domo_dataset_sources_period_shape'
  ) then
    raise exception 'Domo month/year period contract was not installed';
  end if;
  if pg_catalog.to_regprocedure(
    'public.create_domo_dataset_source(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer)'
  ) is null then
    raise exception 'Domo month/year creation RPC was not installed';
  end if;
  if pg_catalog.to_regprocedure(
    'public.create_domo_dataset_source(uuid,uuid,text,text,text,text,text,text,text,text)'
  ) is not null then
    raise exception 'Legacy Domo creation RPC remains executable';
  end if;
end;
$$;

commit;
