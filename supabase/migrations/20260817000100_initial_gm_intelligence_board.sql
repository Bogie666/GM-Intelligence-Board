-- GM Intelligence Board: initial tenant-safe Supabase schema.
--
-- This migration intentionally creates no organizations, users, memberships, locations,
-- connections, or demo KPI data. Auth users are created by Supabase Auth. A trusted
-- bootstrap path using the service role must then create the matching profile, first
-- organization, and first owner membership in one transaction. Browser clients cannot
-- self-provision an organization or elevate a membership.
--
-- Provider credentials never belong in this database. service_titan_connections stores
-- only a secret_reference: an opaque identifier for an external managed secret. OAuth
-- tokens, client secrets, app keys, API keys, and credential payloads must stay in the
-- worker's secret manager and must never be placed in JSONB or audit events.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- Shared validation and trigger helpers ----------

create or replace function public.is_finite_numeric(value numeric)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select value is not null and value::text not in ('NaN', 'Infinity', '-Infinity');
$$;

create or replace function public.jsonb_has_forbidden_credential_keys(payload jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  item record;
  element jsonb;
  normalized_key text;
begin
  if payload is null then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(payload) = 'object' then
    for item in select key, value from pg_catalog.jsonb_each(payload)
    loop
      normalized_key := pg_catalog.lower(pg_catalog.regexp_replace(item.key, '[^a-z0-9]', '', 'g'));
      -- secret_reference is the sole allowed credential-adjacent metadata key.
      if normalized_key <> 'secretreference'
         and normalized_key ~ '(oauth|accesstoken|refreshtoken|clientsecret|clientid|appkey|apikey|password|authorization|bearer|credential|secret)' then
        return true;
      end if;
      if public.jsonb_has_forbidden_credential_keys(item.value) then
        return true;
      end if;
    end loop;
  elsif pg_catalog.jsonb_typeof(payload) = 'array' then
    for element in select value from pg_catalog.jsonb_array_elements(payload)
    loop
      if public.jsonb_has_forbidden_credential_keys(element) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function public.canonical_source_fingerprint(payload jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 'gmib-source-v1.' || pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

-- ---------- Identity and tenancy ----------

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  constraint organizations_name_not_blank check (pg_catalog.btrim(name) <> ''),
  constraint organizations_settings_object check (pg_catalog.jsonb_typeof(settings) = 'object'),
  constraint organizations_settings_no_credentials check (not public.jsonb_has_forbidden_credential_keys(settings)),
  constraint organizations_slug_unique unique (slug)
);

create table public.locations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  location_key text not null,
  brand_name text not null,
  display_name text not null,
  timezone text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  presentation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint locations_key_format check (location_key ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  constraint locations_names_not_blank check (pg_catalog.btrim(brand_name) <> '' and pg_catalog.btrim(display_name) <> ''),
  constraint locations_timezone_not_blank check (pg_catalog.btrim(timezone) <> ''),
  constraint locations_presentation_object check (pg_catalog.jsonb_typeof(presentation) = 'object'),
  constraint locations_presentation_no_credentials check (not public.jsonb_has_forbidden_credential_keys(presentation)),
  constraint locations_org_key_unique unique (organization_id, location_key),
  constraint locations_org_id_unique unique (organization_id, id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  job_title text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint profiles_display_name_not_blank check (display_name is null or pg_catalog.btrim(display_name) <> ''),
  constraint profiles_job_title_not_blank check (job_title is null or pg_catalog.btrim(job_title) <> '')
);

create table public.organization_memberships (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  role text not null check (role in ('owner', 'admin', 'brand_executive', 'general_manager', 'department_leader', 'viewer')),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended', 'revoked')),
  invited_by uuid references public.profiles(id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_memberships_joined_state check ((status = 'active' and joined_at is not null) or status <> 'active'),
  constraint organization_memberships_org_profile_unique unique (organization_id, profile_id),
  constraint organization_memberships_org_id_unique unique (organization_id, id)
);

create index locations_organization_status_idx on public.locations (organization_id, status);
create index memberships_profile_active_idx on public.organization_memberships (profile_id, organization_id) where status = 'active';
create index memberships_org_role_active_idx on public.organization_memberships (organization_id, role) where status = 'active';

-- Fixed-query SECURITY DEFINER helpers avoid RLS recursion. They do not accept SQL,
-- mutate rows, or expose membership data. The empty search_path and fully-qualified
-- names prevent object-shadowing privilege escalation.
create or replace function public.is_active_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.organization_id = target_organization_id
      and membership.profile_id = auth.uid()
      and membership.status = 'active'
      and organization.status = 'active'
  );
$$;

create or replace function public.has_organization_role(target_organization_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.organization_id = target_organization_id
      and membership.profile_id = auth.uid()
      and membership.status = 'active'
      and membership.role = any (allowed_roles)
      and organization.status = 'active'
  );
$$;

create or replace function public.can_read_profile(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_profile_id = auth.uid()
    or exists (
      select 1
      from public.organization_memberships mine
      join public.organization_memberships theirs
        on theirs.organization_id = mine.organization_id
      join public.organizations organization on organization.id = mine.organization_id
      where mine.profile_id = auth.uid()
        and mine.status = 'active'
        and theirs.profile_id = target_profile_id
        and theirs.status = 'active'
        and organization.status = 'active'
    );
$$;

revoke all on function public.is_active_organization_member(uuid) from public;
revoke all on function public.has_organization_role(uuid, text[]) from public;
revoke all on function public.can_read_profile(uuid) from public;
grant execute on function public.is_active_organization_member(uuid) to authenticated;
grant execute on function public.has_organization_role(uuid, text[]) to authenticated;
grant execute on function public.can_read_profile(uuid) to authenticated;

-- ---------- Credential-free ServiceTitan registry ----------

create table public.service_titan_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  service_titan_tenant_id text not null,
  display_name text not null,
  environment text not null check (environment in ('production', 'integration')),
  secret_reference text not null,
  capabilities jsonb not null default '[]'::jsonb,
  status text not null default 'needs_attention' check (status in ('needs_attention', 'ready', 'disabled', 'archived')),
  last_validated_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint service_titan_connections_tenant_not_blank check (pg_catalog.btrim(service_titan_tenant_id) <> ''),
  constraint service_titan_connections_name_not_blank check (pg_catalog.btrim(display_name) <> ''),
  constraint service_titan_connections_secret_reference_format check (secret_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,254}$'),
  constraint service_titan_connections_capabilities_array check (pg_catalog.jsonb_typeof(capabilities) = 'array'),
  constraint service_titan_connections_capabilities_no_credentials check (not public.jsonb_has_forbidden_credential_keys(capabilities)),
  constraint service_titan_connections_org_tenant_unique unique (organization_id, service_titan_tenant_id),
  constraint service_titan_connections_org_id_unique unique (organization_id, id),
  constraint service_titan_connections_org_id_tenant_unique unique (organization_id, id, service_titan_tenant_id)
);

comment on column public.service_titan_connections.secret_reference is
  'Opaque identifier for a managed secret outside Postgres. Never store OAuth tokens, client secrets, app keys, API keys, or secret values here.';
comment on table public.service_titan_connections is
  'Credential-free provider metadata. A service-role worker resolves secret_reference in an external secret manager.';

create table public.service_titan_connection_locations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  location_id uuid not null,
  assigned_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint st_connection_locations_connection_fk foreign key (organization_id, connection_id)
    references public.service_titan_connections(organization_id, id) on delete restrict,
  constraint st_connection_locations_location_fk foreign key (organization_id, location_id)
    references public.locations(organization_id, id) on delete restrict,
  constraint st_connection_locations_time_order check (revoked_at is null or revoked_at >= assigned_at)
);

create unique index st_connection_locations_one_active_connection_idx
  on public.service_titan_connection_locations (organization_id, location_id)
  where revoked_at is null;
create unique index st_connection_locations_one_active_assignment_idx
  on public.service_titan_connection_locations (organization_id, connection_id, location_id)
  where revoked_at is null;
create index st_connection_locations_connection_idx
  on public.service_titan_connection_locations (organization_id, connection_id) where revoked_at is null;

create table public.service_titan_report_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  service_titan_tenant_id text not null,
  category_id text not null,
  report_id text not null,
  owner_external_id text not null,
  owner_display_name text not null,
  name text not null,
  description text not null default '',
  parameters jsonb not null default '[]'::jsonb,
  fields jsonb not null,
  expected_schema_fingerprint text not null,
  observed_schema_fingerprint text,
  provider_modified_at timestamptz not null,
  canonical_source_fingerprint text not null,
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'inspected', 'reconciled', 'approved', 'archived')),
  status text not null default 'active' check (status in ('active', 'archived')),
  verification text not null default 'declared' check (verification in ('declared', 'inspected')),
  inspected_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint st_report_sources_connection_fk foreign key (organization_id, connection_id, service_titan_tenant_id)
    references public.service_titan_connections(organization_id, id, service_titan_tenant_id) on delete restrict,
  constraint st_report_sources_identity_not_blank check (
    pg_catalog.btrim(category_id) <> '' and pg_catalog.btrim(report_id) <> ''
    and pg_catalog.btrim(owner_external_id) <> '' and pg_catalog.btrim(owner_display_name) <> ''
  ),
  constraint st_report_sources_name_not_blank check (pg_catalog.btrim(name) <> ''),
  constraint st_report_sources_parameters_array check (pg_catalog.jsonb_typeof(parameters) = 'array'),
  constraint st_report_sources_fields_nonempty_array check (pg_catalog.jsonb_typeof(fields) = 'array' and pg_catalog.jsonb_array_length(fields) > 0),
  constraint st_report_sources_json_no_credentials check (
    not public.jsonb_has_forbidden_credential_keys(parameters)
    and not public.jsonb_has_forbidden_credential_keys(fields)
  ),
  constraint st_report_sources_schema_not_blank check (pg_catalog.btrim(expected_schema_fingerprint) <> ''),
  constraint st_report_sources_lifecycle_status check ((lifecycle = 'archived') = (status = 'archived')),
  constraint st_report_sources_approval_fields check (
    lifecycle <> 'approved'
    or (status = 'active' and observed_schema_fingerprint = expected_schema_fingerprint and approved_at is not null and approved_by is not null)
  ),
  constraint st_report_sources_identity_unique unique (organization_id, connection_id, category_id, report_id),
  constraint st_report_sources_org_id_unique unique (organization_id, id),
  constraint st_report_sources_binding_identity_unique unique (organization_id, id, connection_id, service_titan_tenant_id)
);

create index st_report_sources_org_lifecycle_idx on public.service_titan_report_sources (organization_id, lifecycle, status);
create index st_report_sources_connection_idx on public.service_titan_report_sources (organization_id, connection_id);

create or replace function public.set_report_source_fingerprint()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.canonical_source_fingerprint := public.canonical_source_fingerprint(
    pg_catalog.jsonb_build_object(
      'organizationId', new.organization_id,
      'connectionId', new.connection_id,
      'tenantId', new.service_titan_tenant_id,
      'categoryId', new.category_id,
      'reportId', new.report_id,
      'ownerId', new.owner_external_id,
      'providerModifiedEpoch', extract(epoch from new.provider_modified_at),
      'expectedSchemaFingerprint', new.expected_schema_fingerprint,
      'parameters', new.parameters,
      'fields', new.fields
    )
  );
  return new;
end;
$$;

create or replace function public.protect_report_source_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.connection_id is distinct from old.connection_id
     or new.service_titan_tenant_id is distinct from old.service_titan_tenant_id
     or new.category_id is distinct from old.category_id
     or new.report_id is distinct from old.report_id then
    raise exception 'ServiceTitan report organization/connection/tenant/category/report identity is immutable; register a new source';
  end if;
  return new;
end;
$$;

create or replace function public.protect_connection_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.service_titan_tenant_id is distinct from old.service_titan_tenant_id
     or new.environment is distinct from old.environment then
    raise exception 'ServiceTitan connection organization/tenant/environment identity is immutable; create a new connection';
  end if;
  return new;
end;
$$;

create trigger service_titan_connections_protect_identity
before update on public.service_titan_connections
for each row execute function public.protect_connection_identity();

create trigger service_titan_report_sources_10_protect_identity
before update on public.service_titan_report_sources
for each row execute function public.protect_report_source_identity();
create trigger service_titan_report_sources_20_fingerprint
before insert or update on public.service_titan_report_sources
for each row execute function public.set_report_source_fingerprint();

create table public.service_titan_report_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  report_source_id uuid not null,
  evidence_type text not null check (evidence_type in ('sample', 'reconciliation')),
  source_fingerprint text not null,
  status text not null check (status in ('pass', 'fail')),
  row_count bigint,
  computed_value numeric,
  expected_value numeric,
  reference_value numeric,
  tolerance numeric,
  delta numeric,
  observed_at timestamptz not null,
  details jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default pg_catalog.now(),
  recorded_by uuid references public.profiles(id) on delete set null,
  constraint st_report_evidence_report_fk foreign key (organization_id, report_source_id)
    references public.service_titan_report_sources(organization_id, id) on delete restrict,
  constraint st_report_evidence_details_object check (pg_catalog.jsonb_typeof(details) = 'object'),
  constraint st_report_evidence_details_no_credentials check (not public.jsonb_has_forbidden_credential_keys(details)),
  constraint st_report_evidence_shape check (
    (evidence_type = 'sample' and row_count is not null and row_count >= 0
      and public.is_finite_numeric(computed_value)
      and expected_value is null and reference_value is null and tolerance is null and delta is null)
    or
    (evidence_type = 'reconciliation' and row_count is null and computed_value is null
      and public.is_finite_numeric(expected_value) and public.is_finite_numeric(reference_value)
      and public.is_finite_numeric(tolerance) and tolerance >= 0
      and public.is_finite_numeric(delta) and delta = expected_value - reference_value
      and ((status = 'pass' and pg_catalog.abs(delta) <= tolerance)
        or (status = 'fail' and pg_catalog.abs(delta) > tolerance)))
  )
);

create index st_report_evidence_lookup_idx
  on public.service_titan_report_evidence (report_source_id, source_fingerprint, evidence_type, status, observed_at desc);

create or replace function public.bind_report_evidence_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_organization_id uuid;
  expected_fingerprint text;
begin
  select source.organization_id, source.canonical_source_fingerprint
    into expected_organization_id, expected_fingerprint
  from public.service_titan_report_sources source
  where source.id = new.report_source_id;

  if expected_fingerprint is null then
    raise exception 'Unknown ServiceTitan report source';
  end if;
  if new.organization_id <> expected_organization_id then
    raise exception 'Report evidence organization mismatch';
  end if;
  new.source_fingerprint := expected_fingerprint;
  return new;
end;
$$;

-- Evidence and observations are immutable facts. Workers append replacement rows.
create or replace function public.reject_fact_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only; append a replacement fact instead', tg_table_name;
end;
$$;

create trigger st_report_evidence_bind_fingerprint
before insert on public.service_titan_report_evidence
for each row execute function public.bind_report_evidence_fingerprint();
create trigger st_report_evidence_append_only
before update or delete on public.service_titan_report_evidence
for each row execute function public.reject_fact_mutation();

create or replace function public.validate_report_source_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lifecycle = 'approved' and old.lifecycle is distinct from 'approved' then
    if not exists (
      select 1 from public.service_titan_report_evidence evidence
      where evidence.report_source_id = new.id
        and evidence.source_fingerprint = new.canonical_source_fingerprint
        and evidence.evidence_type = 'sample' and evidence.status = 'pass'
    ) or not exists (
      select 1 from public.service_titan_report_evidence evidence
      where evidence.report_source_id = new.id
        and evidence.source_fingerprint = new.canonical_source_fingerprint
        and evidence.evidence_type = 'reconciliation' and evidence.status = 'pass'
    ) then
      raise exception 'Report approval requires passing sample and reconciliation evidence for the current canonical source fingerprint';
    end if;
  end if;
  return new;
end;
$$;

create trigger service_titan_report_sources_30_validate_approval
before insert or update on public.service_titan_report_sources
for each row execute function public.validate_report_source_approval();

-- ---------- Governed KPI definitions and exact location bindings ----------

create table public.custom_kpi_definitions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kpi_key text not null,
  version integer not null default 1 check (version > 0),
  type text not null check (type in ('catalog', 'derived', 'service_titan', 'manual', 'external')),
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'published', 'archived')),
  title text not null,
  business_definition text not null,
  owner_profile_id uuid not null references public.profiles(id) on delete restrict,
  section text not null check (section in ('executive', 'revenue', 'calls', 'appointments', 'sales', 'membership')),
  value_kind text not null check (value_kind in ('currency', 'number', 'percent', 'ratio')),
  direction text not null check (direction in ('higher', 'lower', 'informational')),
  subtitle text not null default '',
  scope_mode text not null check (scope_mode in ('portfolio', 'selected_locations')),
  viewer_roles jsonb not null default '[]'::jsonb,
  formula jsonb not null default '{}'::jsonb,
  external_source jsonb not null default '{}'::jsonb,
  refresh_cadence text check (refresh_cadence in ('15m', '30m', '1h', '4h', '12h', '24h', 'daily', 'weekly', 'monthly', 'ad_hoc')),
  stale_after_hours numeric,
  release_note text not null default '',
  validation_results jsonb not null default '[]'::jsonb,
  validated_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint custom_kpi_key_format check (kpi_key ~ '^[a-z0-9][a-z0-9-]{2,54}$'),
  constraint custom_kpi_text_not_blank check (pg_catalog.btrim(title) <> '' and pg_catalog.btrim(business_definition) <> ''),
  constraint custom_kpi_json_shapes check (
    pg_catalog.jsonb_typeof(viewer_roles) = 'array'
    and pg_catalog.jsonb_typeof(formula) = 'object'
    and pg_catalog.jsonb_typeof(external_source) = 'object'
    and pg_catalog.jsonb_typeof(validation_results) = 'array'
  ),
  constraint custom_kpi_json_no_credentials check (
    not public.jsonb_has_forbidden_credential_keys(viewer_roles)
    and not public.jsonb_has_forbidden_credential_keys(formula)
    and not public.jsonb_has_forbidden_credential_keys(external_source)
    and not public.jsonb_has_forbidden_credential_keys(validation_results)
  ),
  constraint custom_kpi_stale_hours check (stale_after_hours is null or (public.is_finite_numeric(stale_after_hours) and stale_after_hours > 0)),
  constraint custom_kpi_publication_fields check (lifecycle <> 'published' or (validated_at is not null and published_at is not null and pg_catalog.btrim(release_note) <> '')),
  constraint custom_kpi_org_key_version_unique unique (organization_id, kpi_key, version),
  constraint custom_kpi_org_id_unique unique (organization_id, id)
);

create unique index custom_kpi_one_published_version_idx
  on public.custom_kpi_definitions (organization_id, kpi_key) where lifecycle = 'published';
create index custom_kpi_org_lifecycle_idx on public.custom_kpi_definitions (organization_id, lifecycle, section);

create or replace function public.protect_kpi_definition_governance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.kpi_key is distinct from old.kpi_key
     or new.version is distinct from old.version then
    raise exception 'KPI organization/key/version identity is immutable; create a new version';
  end if;

  if old.lifecycle in ('published', 'archived') then
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'updated_at']) then
      raise exception 'Published or archived KPI versions are immutable; create a new version';
    end if;
    if old.lifecycle = 'archived' and new.lifecycle <> 'archived' then
      raise exception 'Archived KPI versions cannot be reactivated';
    end if;
  end if;
  return new;
end;
$$;

create trigger custom_kpi_definitions_protect_governance
before update on public.custom_kpi_definitions
for each row execute function public.protect_kpi_definition_governance();

-- Endpoint recipes are application-owned, versioned contracts. Keep cadence policy in a
-- normalized server-side allowlist so a client cannot submit a globally valid interval
-- that the selected recipe does not support. New recipe versions must be added by migration.
create table public.service_titan_endpoint_recipe_refresh_policies (
  endpoint_recipe_id text not null,
  endpoint_recipe_version integer not null check (endpoint_recipe_version > 0),
  refresh_interval text not null check (refresh_interval in ('15m', '30m', '1h', '4h', '24h')),
  constraint st_endpoint_recipe_policy_id_not_blank check (pg_catalog.btrim(endpoint_recipe_id) <> ''),
  constraint st_endpoint_recipe_refresh_policy_pk
    primary key (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
);

insert into public.service_titan_endpoint_recipe_refresh_policies
  (endpoint_recipe_id, endpoint_recipe_version, refresh_interval)
values
  ('completed-revenue', 1, '15m'),
  ('completed-revenue', 1, '30m'),
  ('completed-revenue', 1, '1h'),
  ('completed-revenue', 1, '4h'),
  ('completed-revenue', 1, '24h'),
  ('completed-appointments', 1, '15m'),
  ('completed-appointments', 1, '30m'),
  ('completed-appointments', 1, '1h'),
  ('completed-appointments', 1, '4h'),
  ('completed-appointments', 1, '24h'),
  ('sales-close-rate', 1, '30m'),
  ('sales-close-rate', 1, '1h'),
  ('sales-close-rate', 1, '4h'),
  ('sales-close-rate', 1, '24h'),
  ('active-memberships', 1, '1h'),
  ('active-memberships', 1, '4h'),
  ('active-memberships', 1, '24h'),
  ('inbound-call-booking-rate', 1, '15m'),
  ('inbound-call-booking-rate', 1, '30m'),
  ('inbound-call-booking-rate', 1, '1h'),
  ('inbound-call-booking-rate', 1, '4h');

create or replace function public.is_endpoint_recipe_refresh_allowed(
  target_recipe_id text,
  target_recipe_version integer,
  target_refresh_interval text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.service_titan_endpoint_recipe_refresh_policies policy
    where policy.endpoint_recipe_id = target_recipe_id
      and policy.endpoint_recipe_version = target_recipe_version
      and policy.refresh_interval = target_refresh_interval
  );
$$;

revoke all on function public.is_endpoint_recipe_refresh_allowed(text, integer, text) from public;

comment on table public.service_titan_endpoint_recipe_refresh_policies is
  'Migration-owned allowlist of refresh intervals for each versioned ServiceTitan endpoint recipe. Binding writes are rejected unless an exact row exists.';
comment on function public.is_endpoint_recipe_refresh_allowed(text, integer, text) is
  'Returns true only for an exact recipe ID, recipe version, and refresh interval allowlisted by the database.';

-- Migration-time smoke checks catch accidental policy truncation and confirm fail-closed
-- behavior for unsupported and unknown recipe/cadence combinations.
do $$
begin
  if (select pg_catalog.count(*) from public.service_titan_endpoint_recipe_refresh_policies) <> 21
     or (select pg_catalog.count(distinct (endpoint_recipe_id, endpoint_recipe_version))
         from public.service_titan_endpoint_recipe_refresh_policies) <> 5
     or not public.is_endpoint_recipe_refresh_allowed('completed-revenue', 1, '15m')
     or public.is_endpoint_recipe_refresh_allowed('active-memberships', 1, '15m')
     or public.is_endpoint_recipe_refresh_allowed('unknown-recipe', 1, '1h') then
    raise exception 'ServiceTitan endpoint recipe refresh policy seed verification failed';
  end if;
end;
$$;

create table public.custom_kpi_location_bindings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kpi_definition_id uuid not null,
  location_id uuid not null,
  connection_id uuid,
  service_titan_tenant_id text,
  source_method text check (source_method in ('endpoint_recipe', 'saved_report')),
  endpoint_recipe_id text,
  endpoint_recipe_version integer,
  report_source_id uuid,
  refresh_interval text check (refresh_interval in ('15m', '30m', '1h', '4h', '12h', '24h')),
  report_reduction text check (report_reduction in ('sum', 'average', 'count', 'latest', 'ratio')),
  parameter_values jsonb not null default '{}'::jsonb,
  business_unit_mappings jsonb not null default '{}'::jsonb,
  value_field text,
  numerator_field text,
  denominator_field text,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'approved', 'rejected', 'archived')),
  canonical_source_fingerprint text,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint custom_kpi_bindings_definition_fk foreign key (organization_id, kpi_definition_id)
    references public.custom_kpi_definitions(organization_id, id) on delete restrict,
  constraint custom_kpi_bindings_location_fk foreign key (organization_id, location_id)
    references public.locations(organization_id, id) on delete restrict,
  constraint custom_kpi_bindings_connection_fk foreign key (organization_id, connection_id, service_titan_tenant_id)
    references public.service_titan_connections(organization_id, id, service_titan_tenant_id) on delete restrict,
  constraint custom_kpi_bindings_report_fk foreign key (organization_id, report_source_id, connection_id, service_titan_tenant_id)
    references public.service_titan_report_sources(organization_id, id, connection_id, service_titan_tenant_id) on delete restrict,
  constraint custom_kpi_binding_json_objects check (
    pg_catalog.jsonb_typeof(parameter_values) = 'object' and pg_catalog.jsonb_typeof(business_unit_mappings) = 'object'
  ),
  constraint custom_kpi_binding_json_no_credentials check (
    not public.jsonb_has_forbidden_credential_keys(parameter_values)
    and not public.jsonb_has_forbidden_credential_keys(business_unit_mappings)
  ),
  constraint custom_kpi_binding_source_shape check (
    (source_method is null and connection_id is null and service_titan_tenant_id is null
      and endpoint_recipe_id is null and endpoint_recipe_version is null and report_source_id is null
      and refresh_interval is null and report_reduction is null and canonical_source_fingerprint is null)
    or
    (source_method = 'endpoint_recipe' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is not null and pg_catalog.btrim(endpoint_recipe_id) <> ''
      and endpoint_recipe_version is not null and endpoint_recipe_version > 0
      and report_source_id is null and refresh_interval is not null and report_reduction is null)
    or
    (source_method = 'saved_report' and connection_id is not null and service_titan_tenant_id is not null
      and endpoint_recipe_id is null and endpoint_recipe_version is null
      and report_source_id is not null and refresh_interval in ('4h', '12h', '24h') and report_reduction is not null)
  ),
  constraint custom_kpi_binding_ratio_fields check (
    report_reduction <> 'ratio'
    or (numerator_field is not null and denominator_field is not null
      and pg_catalog.btrim(numerator_field) <> '' and pg_catalog.btrim(denominator_field) <> ''
      and numerator_field <> denominator_field)
  ),
  constraint custom_kpi_binding_approval_fields check (approval_status <> 'approved' or (approved_at is not null and approved_by is not null)),
  constraint custom_kpi_binding_exact_location_unique unique (organization_id, kpi_definition_id, location_id),
  constraint custom_kpi_binding_org_id_unique unique (organization_id, id)
);

create index custom_kpi_bindings_location_idx on public.custom_kpi_location_bindings (organization_id, location_id);
create index custom_kpi_bindings_connection_idx on public.custom_kpi_location_bindings (organization_id, connection_id) where connection_id is not null;
create index custom_kpi_bindings_report_idx on public.custom_kpi_location_bindings (report_source_id) where report_source_id is not null;

create or replace function public.set_and_validate_kpi_binding_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  definition_type text;
  report_fingerprint text;
begin
  select definition.type into definition_type
  from public.custom_kpi_definitions definition
  where definition.id = new.kpi_definition_id and definition.organization_id = new.organization_id;

  if definition_type is null then
    raise exception 'Unknown KPI definition for location binding';
  end if;
  if definition_type = 'service_titan' and new.source_method is null then
    raise exception 'ServiceTitan KPI location bindings require an endpoint recipe or saved report';
  elsif definition_type <> 'service_titan' and new.source_method is not null then
    raise exception 'Only ServiceTitan KPI definitions may use ServiceTitan source bindings';
  end if;

  if new.source_method = 'endpoint_recipe'
     and not public.is_endpoint_recipe_refresh_allowed(
       new.endpoint_recipe_id,
       new.endpoint_recipe_version,
       new.refresh_interval
     ) then
    raise exception 'Refresh interval % is not allowed for ServiceTitan endpoint recipe % version %',
      new.refresh_interval, new.endpoint_recipe_id, new.endpoint_recipe_version;
  end if;

  if new.source_method is not null and not exists (
    select 1 from public.service_titan_connection_locations assignment
    where assignment.organization_id = new.organization_id
      and assignment.connection_id = new.connection_id
      and assignment.location_id = new.location_id
      and assignment.revoked_at is null
  ) then
    raise exception 'The exact active ServiceTitan connection-to-location assignment is required';
  end if;

  if new.source_method = 'saved_report' then
    select source.canonical_source_fingerprint into report_fingerprint
    from public.service_titan_report_sources source
    where source.id = new.report_source_id
      and source.organization_id = new.organization_id
      and source.connection_id = new.connection_id
      and source.service_titan_tenant_id = new.service_titan_tenant_id;
    if report_fingerprint is null then
      raise exception 'Saved-report binding identity does not match its organization, connection, and tenant';
    end if;
  end if;

  if new.source_method is null then
    new.canonical_source_fingerprint := null;
  else
    new.canonical_source_fingerprint := public.canonical_source_fingerprint(
      pg_catalog.jsonb_build_object(
        'organizationId', new.organization_id,
        'kpiDefinitionId', new.kpi_definition_id,
        'locationId', new.location_id,
        'connectionId', new.connection_id,
        'tenantId', new.service_titan_tenant_id,
        'method', new.source_method,
        'recipeId', new.endpoint_recipe_id,
        'recipeVersion', new.endpoint_recipe_version,
        'reportSourceId', new.report_source_id,
        'reportFingerprint', report_fingerprint,
        'refreshInterval', new.refresh_interval,
        'parameterValues', new.parameter_values,
        'businessUnitMappings', new.business_unit_mappings,
        'reduction', new.report_reduction,
        'valueField', new.value_field,
        'numeratorField', new.numerator_field,
        'denominatorField', new.denominator_field
      )
    );
  end if;
  return new;
end;
$$;

create trigger custom_kpi_bindings_10_fingerprint
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.set_and_validate_kpi_binding_fingerprint();

create table public.custom_kpi_binding_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  binding_id uuid not null,
  evidence_type text not null check (evidence_type in ('sample', 'reconciliation')),
  source_fingerprint text not null,
  status text not null check (status in ('pass', 'fail')),
  row_count bigint,
  computed_value numeric,
  expected_value numeric,
  reference_value numeric,
  tolerance numeric,
  delta numeric,
  observed_at timestamptz not null,
  details jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default pg_catalog.now(),
  recorded_by uuid references public.profiles(id) on delete set null,
  constraint custom_kpi_binding_evidence_binding_fk foreign key (organization_id, binding_id)
    references public.custom_kpi_location_bindings(organization_id, id) on delete restrict,
  constraint custom_kpi_binding_evidence_details_object check (pg_catalog.jsonb_typeof(details) = 'object'),
  constraint custom_kpi_binding_evidence_no_credentials check (not public.jsonb_has_forbidden_credential_keys(details)),
  constraint custom_kpi_binding_evidence_shape check (
    (evidence_type = 'sample' and row_count is not null and row_count >= 0
      and public.is_finite_numeric(computed_value)
      and expected_value is null and reference_value is null and tolerance is null and delta is null)
    or
    (evidence_type = 'reconciliation' and row_count is null and computed_value is null
      and public.is_finite_numeric(expected_value) and public.is_finite_numeric(reference_value)
      and public.is_finite_numeric(tolerance) and tolerance >= 0
      and public.is_finite_numeric(delta) and delta = expected_value - reference_value
      and ((status = 'pass' and pg_catalog.abs(delta) <= tolerance)
        or (status = 'fail' and pg_catalog.abs(delta) > tolerance)))
  )
);

create index custom_kpi_binding_evidence_lookup_idx
  on public.custom_kpi_binding_evidence (binding_id, source_fingerprint, evidence_type, status, observed_at desc);

create or replace function public.bind_kpi_evidence_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_organization_id uuid;
  expected_fingerprint text;
begin
  select binding.organization_id, binding.canonical_source_fingerprint
    into expected_organization_id, expected_fingerprint
  from public.custom_kpi_location_bindings binding
  where binding.id = new.binding_id;

  if expected_fingerprint is null then
    raise exception 'Binding evidence requires a current ServiceTitan source fingerprint';
  end if;
  if new.organization_id <> expected_organization_id then
    raise exception 'Binding evidence organization mismatch';
  end if;
  new.source_fingerprint := expected_fingerprint;
  return new;
end;
$$;

create trigger custom_kpi_binding_evidence_bind_fingerprint
before insert on public.custom_kpi_binding_evidence
for each row execute function public.bind_kpi_evidence_fingerprint();
create trigger custom_kpi_binding_evidence_append_only
before update or delete on public.custom_kpi_binding_evidence
for each row execute function public.reject_fact_mutation();

create or replace function public.validate_kpi_binding_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.approval_status = 'approved' and old.approval_status is distinct from 'approved' then
    if new.canonical_source_fingerprint is null then
      raise exception 'Only fingerprinted ServiceTitan bindings can be approved';
    end if;
    if not exists (
      select 1 from public.custom_kpi_binding_evidence evidence
      where evidence.binding_id = new.id and evidence.source_fingerprint = new.canonical_source_fingerprint
        and evidence.evidence_type = 'sample' and evidence.status = 'pass'
    ) or not exists (
      select 1 from public.custom_kpi_binding_evidence evidence
      where evidence.binding_id = new.id and evidence.source_fingerprint = new.canonical_source_fingerprint
        and evidence.evidence_type = 'reconciliation' and evidence.status = 'pass'
    ) then
      raise exception 'Binding approval requires passing sample and reconciliation evidence for the current canonical source fingerprint';
    end if;
  end if;
  return new;
end;
$$;

create trigger custom_kpi_bindings_20_validate_approval
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.validate_kpi_binding_approval();

-- ---------- Append-only materialized observations ----------

create table public.kpi_observations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  binding_id uuid not null,
  kpi_definition_id uuid not null,
  location_id uuid not null,
  source_fingerprint text not null,
  source_version bigint not null check (source_version > 0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  observed_at timestamptz not null,
  value numeric not null,
  prior_value numeric,
  numerator numeric,
  denominator numeric,
  status text not null check (status in ('valid', 'invalid')),
  confidence text not null default 'unknown' check (confidence in ('high', 'medium', 'low', 'unknown')),
  unmapped_record_count bigint not null default 0 check (unmapped_record_count >= 0),
  resolved_target_id uuid,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint kpi_observations_binding_fk foreign key (organization_id, binding_id)
    references public.custom_kpi_location_bindings(organization_id, id) on delete restrict,
  constraint kpi_observations_definition_fk foreign key (organization_id, kpi_definition_id)
    references public.custom_kpi_definitions(organization_id, id) on delete restrict,
  constraint kpi_observations_location_fk foreign key (organization_id, location_id)
    references public.locations(organization_id, id) on delete restrict,
  constraint kpi_observations_period_order check (period_end > period_start and observed_at >= period_start),
  constraint kpi_observations_values_finite check (
    public.is_finite_numeric(value)
    and (prior_value is null or public.is_finite_numeric(prior_value))
    and (numerator is null or public.is_finite_numeric(numerator))
    and (denominator is null or public.is_finite_numeric(denominator))
  ),
  constraint kpi_observations_idempotency_not_blank check (pg_catalog.btrim(idempotency_key) <> ''),
  constraint kpi_observations_metadata_object check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  constraint kpi_observations_metadata_no_credentials check (not public.jsonb_has_forbidden_credential_keys(metadata)),
  constraint kpi_observations_worker_idempotency_unique unique (organization_id, binding_id, idempotency_key)
);

create index kpi_observations_dashboard_idx
  on public.kpi_observations (organization_id, location_id, kpi_definition_id, period_end desc, recorded_at desc)
  where status = 'valid';
create index kpi_observations_binding_fingerprint_idx
  on public.kpi_observations (binding_id, source_fingerprint, observed_at desc);

create or replace function public.bind_observation_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_organization_id uuid;
  expected_kpi_definition_id uuid;
  expected_location_id uuid;
  expected_source_fingerprint text;
  expected_approval_status text;
  expected_definition_lifecycle text;
begin
  -- Lock both governance rows through the insert transaction so an approval/publication
  -- cannot be concurrently withdrawn after this authoritative materialization check.
  select binding.organization_id,
         binding.kpi_definition_id,
         binding.location_id,
         binding.canonical_source_fingerprint,
         binding.approval_status,
         definition.lifecycle
    into expected_organization_id,
         expected_kpi_definition_id,
         expected_location_id,
         expected_source_fingerprint,
         expected_approval_status,
         expected_definition_lifecycle
  from public.custom_kpi_location_bindings binding
  join public.custom_kpi_definitions definition
    on definition.organization_id = binding.organization_id
   and definition.id = binding.kpi_definition_id
  where binding.id = new.binding_id
  for share of binding, definition;

  if expected_organization_id is null or expected_source_fingerprint is null then
    raise exception 'Observation requires an exact fingerprinted KPI location binding';
  end if;
  if new.organization_id <> expected_organization_id
     or new.kpi_definition_id <> expected_kpi_definition_id
     or new.location_id <> expected_location_id then
    raise exception 'Observation organization/KPI/location identity does not match its binding';
  end if;

  -- Invalid diagnostic facts may be retained, but dashboard-valid facts may materialize
  -- only from the currently approved exact-location binding of a published KPI version.
  if new.status = 'valid'
     and (expected_approval_status is distinct from 'approved'
       or expected_definition_lifecycle is distinct from 'published') then
    raise exception 'Valid observations require an approved location binding and a published KPI definition';
  end if;

  new.source_fingerprint := expected_source_fingerprint;
  return new;
end;
$$;

create trigger kpi_observations_bind_identity
before insert on public.kpi_observations
for each row execute function public.bind_observation_identity();
create trigger kpi_observations_append_only
before update or delete on public.kpi_observations
for each row execute function public.reject_fact_mutation();

-- ---------- Targets and layouts ----------

create table public.kpi_targets (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  location_id uuid,
  kpi_definition_id uuid,
  metric_key text not null,
  version integer not null default 1 check (version > 0),
  target_value numeric not null,
  warning_value numeric,
  effective_from date not null,
  effective_to date,
  dimensions jsonb not null default '{}'::jsonb,
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'published', 'archived')),
  owner_profile_id uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint kpi_targets_location_fk foreign key (organization_id, location_id)
    references public.locations(organization_id, id) on delete restrict,
  constraint kpi_targets_definition_fk foreign key (organization_id, kpi_definition_id)
    references public.custom_kpi_definitions(organization_id, id) on delete restrict,
  constraint kpi_targets_metric_key_format check (metric_key ~ '^[a-z0-9][a-z0-9-]{2,80}$'),
  constraint kpi_targets_values_finite check (
    public.is_finite_numeric(target_value) and (warning_value is null or public.is_finite_numeric(warning_value))
  ),
  constraint kpi_targets_effective_order check (effective_to is null or effective_to >= effective_from),
  constraint kpi_targets_dimensions_object check (pg_catalog.jsonb_typeof(dimensions) = 'object'),
  constraint kpi_targets_dimensions_no_credentials check (not public.jsonb_has_forbidden_credential_keys(dimensions)),
  constraint kpi_targets_approval_fields check (lifecycle <> 'published' or (approved_by is not null and approved_at is not null)),
  constraint kpi_targets_version_unique unique nulls not distinct (organization_id, location_id, metric_key, version, effective_from),
  constraint kpi_targets_org_id_unique unique (organization_id, id)
);

alter table public.kpi_observations
  add constraint kpi_observations_resolved_target_fk
  foreign key (organization_id, resolved_target_id) references public.kpi_targets(organization_id, id) on delete restrict;

create index kpi_targets_resolution_idx
  on public.kpi_targets (organization_id, metric_key, location_id, effective_from desc, version desc)
  where lifecycle = 'published';

create table public.layout_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  template_key text not null,
  name text not null,
  audience_role text not null check (audience_role in ('owner', 'admin', 'brand_executive', 'general_manager', 'department_leader', 'viewer')),
  layout jsonb not null,
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'published', 'archived')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint layout_templates_key_format check (template_key ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  constraint layout_templates_name_not_blank check (pg_catalog.btrim(name) <> ''),
  constraint layout_templates_layout_object check (pg_catalog.jsonb_typeof(layout) = 'object'),
  constraint layout_templates_layout_no_credentials check (not public.jsonb_has_forbidden_credential_keys(layout)),
  constraint layout_templates_version_unique unique (organization_id, template_key, version),
  constraint layout_templates_org_id_unique unique (organization_id, id)
);

create unique index layout_templates_one_published_version_idx
  on public.layout_templates (organization_id, template_key) where lifecycle = 'published';

create table public.profile_layouts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid not null,
  template_id uuid not null,
  overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint profile_layouts_location_fk foreign key (organization_id, location_id)
    references public.locations(organization_id, id) on delete restrict,
  constraint profile_layouts_template_fk foreign key (organization_id, template_id)
    references public.layout_templates(organization_id, id) on delete restrict,
  constraint profile_layouts_overrides_object check (pg_catalog.jsonb_typeof(overrides) = 'object'),
  constraint profile_layouts_overrides_no_credentials check (not public.jsonb_has_forbidden_credential_keys(overrides)),
  constraint profile_layouts_exact_scope_unique unique (organization_id, profile_id, location_id)
);

create index profile_layouts_profile_idx on public.profile_layouts (profile_id, organization_id, location_id);

create or replace function public.validate_profile_layout_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = new.organization_id
      and membership.profile_id = new.profile_id
      and membership.status = 'active'
  ) then
    raise exception 'Profile layouts require an active organization membership';
  end if;
  return new;
end;
$$;

create trigger profile_layouts_validate_membership
before insert or update on public.profile_layouts
for each row execute function public.validate_profile_layout_membership();

-- ---------- Append-only audit ledger ----------

create table public.audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action text not null,
  resource_table text not null,
  resource_id uuid,
  before_state jsonb,
  after_state jsonb,
  request_id text,
  occurred_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint audit_events_action_not_blank check (pg_catalog.btrim(action) <> ''),
  constraint audit_events_resource_not_blank check (pg_catalog.btrim(resource_table) <> ''),
  constraint audit_events_state_objects check (
    (before_state is null or pg_catalog.jsonb_typeof(before_state) = 'object')
    and (after_state is null or pg_catalog.jsonb_typeof(after_state) = 'object')
  ),
  constraint audit_events_no_credentials check (
    not public.jsonb_has_forbidden_credential_keys(before_state)
    and not public.jsonb_has_forbidden_credential_keys(after_state)
  )
);

create index audit_events_org_time_idx on public.audit_events (organization_id, occurred_at desc);
create index audit_events_resource_idx on public.audit_events (organization_id, resource_table, resource_id, occurred_at desc);

create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function public.reject_fact_mutation();

create or replace function public.record_configuration_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row jsonb;
  new_row jsonb;
  target_organization_id uuid;
  target_resource_id uuid;
  event_action text;
  allowed_tables constant text[] := array[
    'organizations', 'locations', 'organization_memberships',
    'service_titan_connections', 'service_titan_connection_locations', 'service_titan_report_sources',
    'custom_kpi_definitions', 'custom_kpi_location_bindings', 'kpi_targets',
    'layout_templates', 'profile_layouts'
  ];
begin
  if tg_table_schema <> 'public' or not (tg_table_name = any (allowed_tables)) then
    raise exception 'Audit trigger may run only on the approved public configuration tables';
  end if;

  old_row := case when tg_op in ('UPDATE', 'DELETE') then pg_catalog.to_jsonb(old) else null end;
  new_row := case when tg_op in ('INSERT', 'UPDATE') then pg_catalog.to_jsonb(new) else null end;
  target_organization_id := coalesce(
    (new_row ->> 'organization_id')::uuid,
    (old_row ->> 'organization_id')::uuid,
    (new_row ->> 'id')::uuid,
    (old_row ->> 'id')::uuid
  );
  target_resource_id := coalesce((new_row ->> 'id')::uuid, (old_row ->> 'id')::uuid);
  event_action := pg_catalog.lower(tg_op);

  insert into public.audit_events (
    organization_id, actor_profile_id, action, resource_table, resource_id, before_state, after_state
  ) values (
    target_organization_id, auth.uid(), event_action, tg_table_name, target_resource_id, old_row, new_row
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Audit configuration changes automatically. Worker facts/evidence are already append-only
-- and should be correlated using their idempotency/detail metadata and worker logs.
create trigger organizations_audit after insert or update or delete on public.organizations
for each row execute function public.record_configuration_audit_event();
create trigger locations_audit after insert or update or delete on public.locations
for each row execute function public.record_configuration_audit_event();
create trigger organization_memberships_audit after insert or update or delete on public.organization_memberships
for each row execute function public.record_configuration_audit_event();
create trigger service_titan_connections_audit after insert or update or delete on public.service_titan_connections
for each row execute function public.record_configuration_audit_event();
create trigger service_titan_connection_locations_audit after insert or update or delete on public.service_titan_connection_locations
for each row execute function public.record_configuration_audit_event();
create trigger service_titan_report_sources_audit after insert or update or delete on public.service_titan_report_sources
for each row execute function public.record_configuration_audit_event();
create trigger custom_kpi_definitions_audit after insert or update or delete on public.custom_kpi_definitions
for each row execute function public.record_configuration_audit_event();
create trigger custom_kpi_location_bindings_audit after insert or update or delete on public.custom_kpi_location_bindings
for each row execute function public.record_configuration_audit_event();
create trigger kpi_targets_audit after insert or update or delete on public.kpi_targets
for each row execute function public.record_configuration_audit_event();
create trigger layout_templates_audit after insert or update or delete on public.layout_templates
for each row execute function public.record_configuration_audit_event();
create trigger profile_layouts_audit after insert or update or delete on public.profile_layouts
for each row execute function public.record_configuration_audit_event();

-- ---------- Updated-at triggers ----------

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();
create trigger locations_set_updated_at before update on public.locations
for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger organization_memberships_set_updated_at before update on public.organization_memberships
for each row execute function public.set_updated_at();
create trigger service_titan_connections_set_updated_at before update on public.service_titan_connections
for each row execute function public.set_updated_at();
create trigger service_titan_connection_locations_set_updated_at before update on public.service_titan_connection_locations
for each row execute function public.set_updated_at();
create trigger service_titan_report_sources_set_updated_at before update on public.service_titan_report_sources
for each row execute function public.set_updated_at();
create trigger custom_kpi_definitions_set_updated_at before update on public.custom_kpi_definitions
for each row execute function public.set_updated_at();
create trigger custom_kpi_location_bindings_set_updated_at before update on public.custom_kpi_location_bindings
for each row execute function public.set_updated_at();
create trigger kpi_targets_set_updated_at before update on public.kpi_targets
for each row execute function public.set_updated_at();
create trigger layout_templates_set_updated_at before update on public.layout_templates
for each row execute function public.set_updated_at();
create trigger profile_layouts_set_updated_at before update on public.profile_layouts
for each row execute function public.set_updated_at();

-- ---------- Row-level security ----------
-- Every public table has RLS. Policies are granted only to authenticated. There are no
-- anon policies. The service_role bypasses RLS and is the sole writer for evidence,
-- observations, and direct audit ingestion. It must remain server/worker-only.

alter table public.organizations enable row level security;
alter table public.locations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.service_titan_connections enable row level security;
alter table public.service_titan_connection_locations enable row level security;
alter table public.service_titan_report_sources enable row level security;
alter table public.service_titan_report_evidence enable row level security;
alter table public.custom_kpi_definitions enable row level security;
alter table public.service_titan_endpoint_recipe_refresh_policies enable row level security;
alter table public.custom_kpi_location_bindings enable row level security;
alter table public.custom_kpi_binding_evidence enable row level security;
alter table public.kpi_observations enable row level security;
alter table public.kpi_targets enable row level security;
alter table public.layout_templates enable row level security;
alter table public.profile_layouts enable row level security;
alter table public.audit_events enable row level security;

create policy organizations_member_read on public.organizations
for select to authenticated using (public.is_active_organization_member(id));
create policy organizations_admin_update on public.organizations
for update to authenticated using (public.has_organization_role(id, array['owner', 'admin']))
with check (public.has_organization_role(id, array['owner', 'admin']));

create policy locations_member_read on public.locations
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy locations_admin_insert on public.locations
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy locations_admin_update on public.locations
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy locations_admin_delete on public.locations
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

-- Profile creation/synchronization is an auth bootstrap responsibility of a trusted
-- service-role hook/backend. Authenticated clients get no profile write policy.
create policy profiles_shared_org_read on public.profiles
for select to authenticated using (public.can_read_profile(id));

create policy memberships_member_read on public.organization_memberships
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy memberships_admin_insert on public.organization_memberships
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy memberships_admin_update on public.organization_memberships
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy memberships_admin_delete on public.organization_memberships
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy st_connections_member_read on public.service_titan_connections
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy st_connections_admin_insert on public.service_titan_connections
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_connections_admin_update on public.service_titan_connections
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_connections_admin_delete on public.service_titan_connections
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy st_connection_locations_member_read on public.service_titan_connection_locations
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy st_connection_locations_admin_insert on public.service_titan_connection_locations
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_connection_locations_admin_update on public.service_titan_connection_locations
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_connection_locations_admin_delete on public.service_titan_connection_locations
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy st_report_sources_member_read on public.service_titan_report_sources
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy st_report_sources_admin_insert on public.service_titan_report_sources
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_report_sources_admin_update on public.service_titan_report_sources
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy st_report_sources_admin_delete on public.service_titan_report_sources
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy st_report_evidence_member_read on public.service_titan_report_evidence
for select to authenticated using (public.is_active_organization_member(organization_id));

create policy custom_kpi_definitions_member_read on public.custom_kpi_definitions
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy custom_kpi_definitions_admin_insert on public.custom_kpi_definitions
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy custom_kpi_definitions_admin_update on public.custom_kpi_definitions
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy custom_kpi_definitions_admin_delete on public.custom_kpi_definitions
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy custom_kpi_bindings_member_read on public.custom_kpi_location_bindings
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy custom_kpi_bindings_admin_insert on public.custom_kpi_location_bindings
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy custom_kpi_bindings_admin_update on public.custom_kpi_location_bindings
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy custom_kpi_bindings_admin_delete on public.custom_kpi_location_bindings
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy custom_kpi_binding_evidence_member_read on public.custom_kpi_binding_evidence
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy kpi_observations_member_read on public.kpi_observations
for select to authenticated using (public.is_active_organization_member(organization_id));

create policy kpi_targets_member_read on public.kpi_targets
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy kpi_targets_admin_insert on public.kpi_targets
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy kpi_targets_admin_update on public.kpi_targets
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy kpi_targets_admin_delete on public.kpi_targets
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy layout_templates_member_read on public.layout_templates
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy layout_templates_admin_insert on public.layout_templates
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy layout_templates_admin_update on public.layout_templates
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy layout_templates_admin_delete on public.layout_templates
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy profile_layouts_member_read on public.profile_layouts
for select to authenticated using (public.is_active_organization_member(organization_id));
create policy profile_layouts_admin_insert on public.profile_layouts
for insert to authenticated with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy profile_layouts_admin_update on public.profile_layouts
for update to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']))
with check (public.has_organization_role(organization_id, array['owner', 'admin']));
create policy profile_layouts_admin_delete on public.profile_layouts
for delete to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy audit_events_admin_read on public.audit_events
for select to authenticated using (public.has_organization_role(organization_id, array['owner', 'admin']));

-- Defense in depth: authenticated and anon use only RLS-mediated table privileges.
-- There are deliberately no authenticated INSERT/UPDATE/DELETE policies for worker facts.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.service_titan_report_evidence from authenticated;
revoke insert, update, delete on public.custom_kpi_binding_evidence from authenticated;
revoke insert, update, delete on public.kpi_observations from authenticated;
revoke insert, update, delete on public.audit_events from authenticated;

comment on table public.service_titan_report_evidence is
  'Append-only worker evidence. source_fingerprint is forced to the report current canonical fingerprint at insert.';
comment on table public.custom_kpi_binding_evidence is
  'Append-only worker evidence. source_fingerprint is forced to the exact location binding current canonical fingerprint at insert.';
comment on table public.kpi_observations is
  'Append-only materialized KPI facts written by a service-role worker; dashboards never query ServiceTitan directly.';
comment on table public.audit_events is
  'Append-only configuration audit ledger. Do not include secrets or credential payloads in audited configuration.';
