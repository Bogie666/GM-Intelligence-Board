-- 022: Governed custom-endpoint and Domo dataset administration.
-- Browser administrators can declare and archive source contracts only through narrow
-- RPCs. Inspection remains an exact-fingerprint service-worker transition, approvals
-- remain service-role-only, and source contracts can never be hard-deleted.

begin;

-- ---------- Direct mutation boundary ----------

drop policy if exists st_custom_endpoint_admin_insert on public.service_titan_custom_endpoint_sources;
drop policy if exists st_custom_endpoint_admin_update on public.service_titan_custom_endpoint_sources;
drop policy if exists st_custom_endpoint_admin_delete on public.service_titan_custom_endpoint_sources;
revoke insert, update, delete on public.service_titan_custom_endpoint_sources from authenticated, service_role;

drop policy if exists domo_dataset_sources_admin_insert on public.domo_dataset_sources;
drop policy if exists domo_dataset_sources_admin_update on public.domo_dataset_sources;
drop policy if exists domo_dataset_sources_admin_delete on public.domo_dataset_sources;
revoke insert, update, delete on public.domo_dataset_sources from authenticated, service_role;

create or replace function public.reject_data_source_hard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_schema <> 'public'
     or tg_table_name not in ('service_titan_custom_endpoint_sources', 'domo_dataset_sources') then
    raise exception 'Data-source hard-delete guard is attached to an unexpected table';
  end if;
  raise exception 'Governed data sources are archive-only and cannot be hard-deleted'
    using errcode = '55000';
end;
$$;
revoke all on function public.reject_data_source_hard_delete() from public, anon, authenticated, service_role;

create trigger st_custom_endpoint_00_reject_delete
before delete on public.service_titan_custom_endpoint_sources
for each row execute function public.reject_data_source_hard_delete();

create trigger domo_dataset_sources_00_reject_delete
before delete on public.domo_dataset_sources
for each row execute function public.reject_data_source_hard_delete();

-- Domo dataset IDs are canonical lower-case GUIDs. The fingerprint trigger performs
-- harmless input normalization before computing the contract fingerprint, while the
-- constraint keeps every writer (including migration/operator paths) fail-closed.
create or replace function public.set_domo_dataset_source_fingerprint()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.dataset_id := pg_catalog.lower(pg_catalog.btrim(new.dataset_id));
  new.canonical_source_fingerprint := public.canonical_source_fingerprint(
    pg_catalog.jsonb_build_object(
      'organizationId', new.organization_id,
      'domoConnectionId', new.domo_connection_id,
      'datasetId', new.dataset_id,
      'valueColumn', new.value_column,
      'reduction', new.reduction,
      'dateColumn', new.date_column,
      'filterColumn', new.filter_column,
      'filterValue', new.filter_value
    )
  );
  return new;
end;
$$;
revoke all on function public.set_domo_dataset_source_fingerprint() from public, anon, authenticated, service_role;

alter table public.domo_dataset_sources
  drop constraint domo_dataset_sources_dataset_id_shape;
alter table public.domo_dataset_sources
  add constraint domo_dataset_sources_dataset_id_shape check (
    dataset_id = pg_catalog.lower(pg_catalog.btrim(dataset_id))
    and dataset_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- Do not silently rewrite filter semantics. Existing control-bearing values block the
-- migration, and all future contracts are rejected by a validated check constraint.
do $$
begin
  if exists (
    select 1 from public.domo_dataset_sources source
    where source.filter_value is not null and source.filter_value ~ '[[:cntrl:]]'
  ) then
    raise exception 'Existing Domo dataset filter values contain control characters; remediate before migration 022'
      using errcode = '23514';
  end if;
end
$$;

alter table public.domo_dataset_sources
  add constraint domo_dataset_sources_filter_value_no_control check (
    filter_value is null or filter_value !~ '[[:cntrl:]]'
  );

-- The existing external_source schema is a credential-free JSON object. Migration 022
-- makes its exact provider discriminator explicit for Domo bindings: {"provider":"domo"}.
-- Existing bindings must already satisfy this contract; no ambiguous provider is inferred.
do $$
begin
  if exists (
    select 1
    from public.custom_kpi_location_bindings binding
    join public.custom_kpi_definitions definition
      on definition.organization_id = binding.organization_id
     and definition.id = binding.kpi_definition_id
    where binding.source_method = 'domo_dataset'
      and definition.external_source ->> 'provider' is distinct from 'domo'
  ) then
    raise exception 'Existing Domo bindings require external_source.provider = domo before migration 022'
      using errcode = '23514';
  end if;
end
$$;

create or replace function public.enforce_domo_binding_provider()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_definition_type text;
  v_external_source jsonb;
begin
  if new.source_method = 'domo_dataset' then
    select definition.type, definition.external_source
      into v_definition_type, v_external_source
    from public.custom_kpi_definitions definition
    where definition.organization_id = new.organization_id
      and definition.id = new.kpi_definition_id;

    if v_definition_type is distinct from 'external'
       or v_external_source ->> 'provider' is distinct from 'domo' then
      raise exception 'Domo dataset bindings require an external KPI with external_source.provider = domo'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_domo_binding_provider() from public, anon, authenticated, service_role;

create trigger custom_kpi_bindings_08_domo_provider
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.enforce_domo_binding_provider();

-- ---------- Authenticated source declaration/archive RPCs ----------

create or replace function public.create_service_titan_custom_endpoint_source(
  p_organization_id uuid,
  p_connection_id uuid,
  p_service_titan_tenant_id text,
  p_name text,
  p_description text,
  p_category text,
  p_query_parameters jsonb,
  p_reduction text,
  p_value_field text,
  p_business_unit_field text
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
  from public.service_titan_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.service_titan_tenant_id = p_service_titan_tenant_id
    and connection.status in ('needs_attention', 'ready')
  for share;
  if not found then
    raise exception 'exact enabled ServiceTitan connection and tenant required' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_query_parameters) is distinct from 'object'
     or not exists (
       select 1 from pg_catalog.jsonb_each_text(p_query_parameters) parameter
       where parameter.key ~* '(on(or)?after|after|from|start|since)$'
         and parameter.value in ('$periodStartIso', '$periodStartDate')
     )
     or not exists (
       select 1 from pg_catalog.jsonb_each_text(p_query_parameters) parameter
       where parameter.key ~* '(on(or)?before|before|to|end|until)$'
         and parameter.value in ('$periodEndIso', '$periodEndDate')
     )
     or exists (
       select 1 from pg_catalog.jsonb_each_text(p_query_parameters) parameter
       where (parameter.key ~* '(on(or)?after|after|from|start|since)$'
              and parameter.value not in ('$periodStartIso', '$periodStartDate'))
          or (parameter.key ~* '(on(or)?before|before|to|end|until)$'
              and parameter.value not in ('$periodEndIso', '$periodEndDate'))
     ) then
    raise exception 'custom endpoint query must use one recognized start and end period placeholder'
      using errcode = '22023';
  end if;

  insert into public.service_titan_custom_endpoint_sources (
    organization_id, connection_id, service_titan_tenant_id, name, description,
    category, query_parameters, reduction, value_field, business_unit_field,
    lifecycle, status, created_by
  ) values (
    p_organization_id, p_connection_id, p_service_titan_tenant_id,
    pg_catalog.btrim(p_name), coalesce(p_description, ''), p_category,
    p_query_parameters, p_reduction, p_value_field, p_business_unit_field,
    'draft', 'active', auth.uid()
  ) returning id into v_source_id;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  )
  select
    source.organization_id, auth.uid(), 'servicetitan.custom_endpoint.create',
    'service_titan_custom_endpoint_sources', source.id, null,
    pg_catalog.jsonb_build_object(
      'lifecycle', source.lifecycle,
      'status', source.status,
      'sourceFingerprint', source.canonical_source_fingerprint
    ),
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  from public.service_titan_custom_endpoint_sources source
  where source.id = v_source_id;

  return v_source_id;
end;
$$;
revoke all on function public.create_service_titan_custom_endpoint_source(
  uuid, uuid, text, text, text, text, jsonb, text, text, text
) from public, anon, service_role;
grant execute on function public.create_service_titan_custom_endpoint_source(
  uuid, uuid, text, text, text, text, jsonb, text, text, text
) to authenticated;

drop function if exists public.archive_service_titan_custom_endpoint_source(uuid, uuid);
create function public.archive_service_titan_custom_endpoint_source(
  p_organization_id uuid,
  p_source_id uuid,
  p_expected_dependent_bindings integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_before_lifecycle text;
  v_fingerprint text;
  v_actual_dependent_bindings integer;
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

  if p_expected_dependent_bindings is null or p_expected_dependent_bindings < 0 then
    raise exception 'expected dependent binding count required' using errcode = '22023';
  end if;
  lock table public.custom_kpi_location_bindings in share row exclusive mode;

  select source.lifecycle, source.canonical_source_fingerprint
    into v_before_lifecycle, v_fingerprint
  from public.service_titan_custom_endpoint_sources source
  where source.organization_id = p_organization_id
    and source.id = p_source_id
    and source.lifecycle <> 'archived'
  for update;
  if not found then return false; end if;

  select pg_catalog.count(*)::integer into v_actual_dependent_bindings
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id
    and binding.custom_endpoint_source_id = p_source_id
    and binding.approval_status <> 'archived';
  if v_actual_dependent_bindings is distinct from p_expected_dependent_bindings then
    raise exception 'custom endpoint dependency count changed; review impact and retry' using errcode = '40001';
  end if;

  update public.service_titan_custom_endpoint_sources source
  set lifecycle = 'archived', status = 'archived', updated_at = pg_catalog.clock_timestamp()
  where source.organization_id = p_organization_id and source.id = p_source_id;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'servicetitan.custom_endpoint.archive',
    'service_titan_custom_endpoint_sources', p_source_id,
    pg_catalog.jsonb_build_object('lifecycle', v_before_lifecycle, 'sourceFingerprint', v_fingerprint),
    pg_catalog.jsonb_build_object('lifecycle', 'archived', 'status', 'archived', 'sourceFingerprint', v_fingerprint),
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  );
  return true;
end;
$$;
revoke all on function public.archive_service_titan_custom_endpoint_source(uuid, uuid, integer)
  from public, anon, service_role;
grant execute on function public.archive_service_titan_custom_endpoint_source(uuid, uuid, integer) to authenticated;

create or replace function public.create_domo_dataset_source(
  p_organization_id uuid,
  p_domo_connection_id uuid,
  p_dataset_id text,
  p_name text,
  p_description text,
  p_value_column text,
  p_reduction text,
  p_date_column text,
  p_filter_column text,
  p_filter_value text
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
    value_column, reduction, date_column, filter_column, filter_value,
    lifecycle, status, created_by
  ) values (
    p_organization_id, p_domo_connection_id,
    pg_catalog.lower(pg_catalog.btrim(p_dataset_id)), pg_catalog.btrim(p_name),
    coalesce(p_description, ''), p_value_column, p_reduction, p_date_column,
    p_filter_column, p_filter_value, 'draft', 'active', auth.uid()
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
      'sourceFingerprint', source.canonical_source_fingerprint
    ),
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  from public.domo_dataset_sources source
  where source.id = v_source_id;

  return v_source_id;
end;
$$;
revoke all on function public.create_domo_dataset_source(
  uuid, uuid, text, text, text, text, text, text, text, text
) from public, anon, service_role;
grant execute on function public.create_domo_dataset_source(
  uuid, uuid, text, text, text, text, text, text, text, text
) to authenticated;

drop function if exists public.archive_domo_dataset_source(uuid, uuid);
create function public.archive_domo_dataset_source(
  p_organization_id uuid,
  p_source_id uuid,
  p_expected_dependent_bindings integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_before_lifecycle text;
  v_fingerprint text;
  v_actual_dependent_bindings integer;
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

  if p_expected_dependent_bindings is null or p_expected_dependent_bindings < 0 then
    raise exception 'expected dependent binding count required' using errcode = '22023';
  end if;
  lock table public.custom_kpi_location_bindings in share row exclusive mode;

  select source.lifecycle, source.canonical_source_fingerprint
    into v_before_lifecycle, v_fingerprint
  from public.domo_dataset_sources source
  where source.organization_id = p_organization_id
    and source.id = p_source_id
    and source.lifecycle <> 'archived'
  for update;
  if not found then return false; end if;

  select pg_catalog.count(*)::integer into v_actual_dependent_bindings
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id
    and binding.domo_dataset_source_id = p_source_id
    and binding.approval_status <> 'archived';
  if v_actual_dependent_bindings is distinct from p_expected_dependent_bindings then
    raise exception 'Domo dataset dependency count changed; review impact and retry' using errcode = '40001';
  end if;

  update public.domo_dataset_sources source
  set lifecycle = 'archived', status = 'archived', updated_at = pg_catalog.clock_timestamp()
  where source.organization_id = p_organization_id and source.id = p_source_id;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values (
    p_organization_id, auth.uid(), 'domo.dataset_source.archive',
    'domo_dataset_sources', p_source_id,
    pg_catalog.jsonb_build_object('lifecycle', v_before_lifecycle, 'sourceFingerprint', v_fingerprint),
    pg_catalog.jsonb_build_object('lifecycle', 'archived', 'status', 'archived', 'sourceFingerprint', v_fingerprint),
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  );
  return true;
end;
$$;
revoke all on function public.archive_domo_dataset_source(uuid, uuid, integer)
  from public, anon, service_role;
grant execute on function public.archive_domo_dataset_source(uuid, uuid, integer) to authenticated;

-- ---------- Exact-fingerprint worker inspection RPCs ----------

create or replace function public.inspect_service_titan_custom_endpoint_source(
  p_organization_id uuid,
  p_source_id uuid,
  p_expected_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.service_titan_custom_endpoint_sources%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_expected_fingerprint is null or pg_catalog.btrim(p_expected_fingerprint) = '' then
    raise exception 'current source fingerprint required' using errcode = '22023';
  end if;

  select source.* into v_source
  from public.service_titan_custom_endpoint_sources source
  where source.organization_id = p_organization_id and source.id = p_source_id
  for update;
  if v_source.id is null or v_source.status <> 'active' or v_source.lifecycle = 'archived' then
    raise exception 'exact active custom endpoint source unavailable' using errcode = 'P0002';
  end if;
  if v_source.canonical_source_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'custom endpoint source fingerprint changed during inspection' using errcode = '40001';
  end if;
  if v_source.lifecycle = 'approved' then
    raise exception 'approved custom endpoint source does not accept inspection transitions' using errcode = '55000';
  end if;

  if v_source.lifecycle = 'draft' then
    update public.service_titan_custom_endpoint_sources source
    set lifecycle = 'inspected', inspected_at = v_now, updated_at = v_now
    where source.organization_id = p_organization_id and source.id = p_source_id;

    insert into public.audit_events (
      organization_id, actor_profile_id, action, resource_table, resource_id,
      before_state, after_state, request_id
    ) values (
      p_organization_id, null, 'servicetitan.custom_endpoint.inspect',
      'service_titan_custom_endpoint_sources', p_source_id,
      pg_catalog.jsonb_build_object('lifecycle', 'draft', 'sourceFingerprint', p_expected_fingerprint),
      pg_catalog.jsonb_build_object('lifecycle', 'inspected', 'sourceFingerprint', p_expected_fingerprint),
      pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
    );
  end if;
  return true;
end;
$$;
revoke all on function public.inspect_service_titan_custom_endpoint_source(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.inspect_service_titan_custom_endpoint_source(uuid, uuid, text) to service_role;

create or replace function public.inspect_domo_dataset_source(
  p_organization_id uuid,
  p_source_id uuid,
  p_expected_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.domo_dataset_sources%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_expected_fingerprint is null or pg_catalog.btrim(p_expected_fingerprint) = '' then
    raise exception 'current source fingerprint required' using errcode = '22023';
  end if;

  select source.* into v_source
  from public.domo_dataset_sources source
  where source.organization_id = p_organization_id and source.id = p_source_id
  for update;
  if v_source.id is null or v_source.status <> 'active' or v_source.lifecycle = 'archived' then
    raise exception 'exact active Domo dataset source unavailable' using errcode = 'P0002';
  end if;
  if v_source.canonical_source_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'Domo dataset source fingerprint changed during inspection' using errcode = '40001';
  end if;
  if v_source.lifecycle = 'approved' then
    raise exception 'approved Domo dataset source does not accept inspection transitions' using errcode = '55000';
  end if;

  if v_source.lifecycle = 'draft' then
    update public.domo_dataset_sources source
    set lifecycle = 'inspected', inspected_at = v_now, updated_at = v_now
    where source.organization_id = p_organization_id and source.id = p_source_id;

    insert into public.audit_events (
      organization_id, actor_profile_id, action, resource_table, resource_id,
      before_state, after_state, request_id
    ) values (
      p_organization_id, null, 'domo.dataset_source.inspect',
      'domo_dataset_sources', p_source_id,
      pg_catalog.jsonb_build_object('lifecycle', 'draft', 'sourceFingerprint', p_expected_fingerprint),
      pg_catalog.jsonb_build_object('lifecycle', 'inspected', 'sourceFingerprint', p_expected_fingerprint),
      pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
    );
  end if;
  return true;
end;
$$;
revoke all on function public.inspect_domo_dataset_source(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.inspect_domo_dataset_source(uuid, uuid, text) to service_role;

-- ---------- Domo connection terminal/status hardening ----------

-- Validation callbacks are accepted only while the connection remains in one of the two
-- live states. In particular, an archived row can never be revived by a late worker.
create or replace function public.set_domo_connection_status(
  p_organization_id uuid,
  p_connection_id uuid,
  p_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'trusted service worker required' using errcode = '42501';
  end if;
  if p_status not in ('ready', 'needs_attention') then
    raise exception 'worker status transition is invalid' using errcode = '22023';
  end if;
  update public.domo_connections connection
  set status = p_status,
      last_validated_at = case when p_status = 'ready' then pg_catalog.clock_timestamp() else connection.last_validated_at end,
      last_error_code = case when p_status = 'ready' then null else pg_catalog.left(p_error_code, 120) end,
      updated_at = pg_catalog.clock_timestamp()
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status in ('needs_attention', 'ready');
  return found;
end;
$$;
revoke all on function public.set_domo_connection_status(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_domo_connection_status(uuid, uuid, text, text) to service_role;

-- Destroy the exact connection-bound Vault row first. Any missing/mismatched secret aborts
-- the transaction, so metadata can never report disabled while retaining its credential.
drop function if exists public.disable_domo_connection(uuid, uuid);
create function public.disable_domo_connection(
  p_organization_id uuid,
  p_connection_id uuid,
  p_expected_dependent_sources integer,
  p_expected_dependent_bindings integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_reference text;
  v_secret_id uuid;
  v_actual_dependent_sources integer;
  v_actual_dependent_bindings integer;
  v_expected_name text := 'gm-intelligence-domo-' || p_connection_id::text;
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

  if p_expected_dependent_sources is null or p_expected_dependent_sources < 0
    or p_expected_dependent_bindings is null or p_expected_dependent_bindings < 0 then
    raise exception 'expected Domo dependency counts required' using errcode = '22023';
  end if;
  lock table public.domo_dataset_sources in share row exclusive mode;
  lock table public.custom_kpi_location_bindings in share row exclusive mode;

  select connection.secret_reference into v_reference
  from public.domo_connections connection
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status in ('needs_attention', 'ready')
  for update;
  if not found then return false; end if;

  select pg_catalog.count(*)::integer into v_actual_dependent_sources
  from public.domo_dataset_sources source
  where source.organization_id = p_organization_id
    and source.domo_connection_id = p_connection_id
    and source.lifecycle <> 'archived';
  select pg_catalog.count(*)::integer into v_actual_dependent_bindings
  from public.custom_kpi_location_bindings binding
  where binding.organization_id = p_organization_id
    and binding.domo_connection_id = p_connection_id
    and binding.approval_status <> 'archived';
  if v_actual_dependent_sources is distinct from p_expected_dependent_sources
    or v_actual_dependent_bindings is distinct from p_expected_dependent_bindings then
    raise exception 'Domo connection dependency counts changed; review impact and retry' using errcode = '40001';
  end if;

  if v_reference !~ '^supabase-vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Domo connection does not have an exact managed Vault reference' using errcode = '22023';
  end if;
  v_secret_id := pg_catalog.replace(v_reference, 'supabase-vault://', '')::uuid;

  delete from vault.secrets secret
  where secret.id = v_secret_id and secret.name = v_expected_name;
  if not found then
    raise exception 'exact Domo Vault credential retirement failed' using errcode = 'P0002';
  end if;

  update public.domo_connections connection
  set status = 'disabled', updated_at = pg_catalog.clock_timestamp()
  where connection.organization_id = p_organization_id
    and connection.id = p_connection_id
    and connection.status in ('needs_attention', 'ready');
  if not found then
    raise exception 'Domo connection changed during disable' using errcode = '40001';
  end if;

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id,
    before_state, after_state, request_id
  ) values
  (
    p_organization_id, auth.uid(), 'domo.secret.retire',
    'domo_connections', p_connection_id, null, null,
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  ),
  (
    p_organization_id, auth.uid(), 'domo.connection.disable',
    'domo_connections', p_connection_id,
    pg_catalog.jsonb_build_object('status', 'enabled'),
    pg_catalog.jsonb_build_object('status', 'disabled'),
    pg_catalog.left(pg_catalog.current_setting('request.id', true), 160)
  );
  return true;
end;
$$;
revoke all on function public.disable_domo_connection(uuid, uuid, integer, integer) from public, anon, service_role;
grant execute on function public.disable_domo_connection(uuid, uuid, integer, integer) to authenticated;

alter table public.domo_dataset_sources
  add constraint domo_dataset_sources_latest_requires_date
  check (reduction <> 'latest' or date_column is not null);

insert into public.schema_releases (release_marker)
values ('20260820002200_data_source_admin_hardening');

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
      and pg_catalog.to_regprocedure('public.create_domo_dataset_source(uuid,uuid,text,text,text,text,text,text,text,text)') is not null
      and pg_catalog.to_regprocedure('public.archive_domo_dataset_source(uuid,uuid,integer)') is not null
      and pg_catalog.to_regprocedure('public.disable_domo_connection(uuid,uuid,integer,integer)') is not null
      and pg_catalog.to_regprocedure('public.inspect_domo_dataset_source(uuid,uuid,text)') is not null
      and exists (
        select 1 from public.schema_releases release
        where release.release_marker = '20260820002200_data_source_admin_hardening'
      ) as ready,
    '20260820002200_data_source_admin_hardening'::text as release_marker;
$$;
revoke all on function public.get_data_platform_release_readiness() from public;
grant execute on function public.get_data_platform_release_readiness() to anon, authenticated, service_role;

commit;
