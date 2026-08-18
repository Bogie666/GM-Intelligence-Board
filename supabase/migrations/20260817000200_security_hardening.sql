-- GM Intelligence Board: forward-only security hardening.
--
-- The initial migration has already reached isolated staging. This migration therefore
-- changes behavior only by moving forward; do not fold these changes into 20260817000100.
-- The service_role remains a trusted server/worker boundary and can bypass RLS. It must
-- never be exposed to browsers, client bundles, logs, or untrusted runtime code.

-- ---------- Secret and JSON credential boundary ----------

create or replace function public.is_valid_secret_reference(value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select value is not null
    and value ~ '^(gcp-secret|supabase-vault|env)://[A-Za-z0-9][A-Za-z0-9._/-]{0,252}$';
$$;

-- There is deliberately no global exception for a key named secret_reference. JSON is
-- untrusted metadata, so credential-like keys at any depth and obvious token values fail.
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
  scalar_value text;
begin
  if payload is null then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(payload) = 'object' then
    for item in select key, value from pg_catalog.jsonb_each(payload)
    loop
      normalized_key := pg_catalog.lower(pg_catalog.regexp_replace(item.key, '[^a-z0-9]', '', 'g'));
      if normalized_key ~ '(oauth|token|clientsecret|clientid|appkey|apikey|password|authorization|bearer|credential|secret|privatekey)' then
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
  elsif pg_catalog.jsonb_typeof(payload) = 'string' then
    scalar_value := payload #>> '{}';
    if scalar_value ~* '^\s*(bearer|token|oauth|access[ _-]*token|refresh[ _-]*token|api[ _-]*key|client[ _-]*secret)\s*[:= ]'
       or scalar_value ~ '^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$'
       or scalar_value ~ '^(gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,})$' then
      return true;
    end if;
  end if;

  return false;
end;
$$;

-- Audit snapshots of a connection retain its opaque reference identifier. This narrow
-- exception permits only the top-level connection column, only for the connection table,
-- and only when it is a recognized reference URI. Nested/arbitrary JSON exceptions do not
-- exist.
create or replace function public.audit_state_has_forbidden_credentials(payload jsonb, resource_table_name text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when payload is null then false
    when resource_table_name = 'service_titan_connections'
         and pg_catalog.jsonb_typeof(payload) = 'object'
         and payload ? 'secret_reference'
      then not public.is_valid_secret_reference(payload ->> 'secret_reference')
        or public.jsonb_has_forbidden_credential_keys(payload - 'secret_reference')
    else public.jsonb_has_forbidden_credential_keys(payload)
  end;
$$;

revoke all on function public.is_valid_secret_reference(text) from public;
revoke all on function public.audit_state_has_forbidden_credentials(jsonb, text) from public;

alter table public.service_titan_connections
  drop constraint if exists service_titan_connections_secret_reference_format;
alter table public.service_titan_connections
  add constraint service_titan_connections_secret_reference_format
  check (public.is_valid_secret_reference(secret_reference));

alter table public.audit_events
  drop constraint if exists audit_events_no_credentials;
alter table public.audit_events
  add constraint audit_events_no_credentials check (
    not public.audit_state_has_forbidden_credentials(before_state, resource_table)
    and not public.audit_state_has_forbidden_credentials(after_state, resource_table)
  );

comment on column public.service_titan_connections.secret_reference is
  'Opaque external-secret URI. Allowed schemes: gcp-secret://, supabase-vault://, and env://. Never store a token or secret value.';
comment on function public.jsonb_has_forbidden_credential_keys(jsonb) is
  'Rejects credential-like keys at any JSON depth, including token and secret_reference, plus conservative obvious token-value patterns.';

-- ---------- Same-organization profile provenance ----------

-- Membership already has the unique key needed for tenant-qualified profile references.
-- Nullable attribution uses MATCH SIMPLE; non-null owners/actors must belong to the row's
-- organization. Historical attribution intentionally prevents membership deletion; revoke
-- the membership instead.
alter table public.service_titan_report_sources
  add constraint st_report_sources_approver_membership_fk
  foreign key (organization_id, approved_by)
  references public.organization_memberships (organization_id, profile_id) on delete restrict;

alter table public.custom_kpi_definitions
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at timestamptz;
alter table public.custom_kpi_definitions
  add constraint custom_kpi_definition_owner_membership_fk
  foreign key (organization_id, owner_profile_id)
  references public.organization_memberships (organization_id, profile_id) on delete restrict,
  add constraint custom_kpi_definition_approver_membership_fk
  foreign key (organization_id, approved_by)
  references public.organization_memberships (organization_id, profile_id) on delete restrict,
  add constraint custom_kpi_definition_approval_fields
  check (lifecycle <> 'published' or (approved_by is not null and approved_at is not null));

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_approver_membership_fk
  foreign key (organization_id, approved_by)
  references public.organization_memberships (organization_id, profile_id) on delete restrict;

alter table public.kpi_targets
  add constraint kpi_target_owner_membership_fk
  foreign key (organization_id, owner_profile_id)
  references public.organization_memberships (organization_id, profile_id) on delete restrict,
  add constraint kpi_target_approver_membership_fk
  foreign key (organization_id, approved_by)
  references public.organization_memberships (organization_id, profile_id) on delete restrict;

alter table public.service_titan_report_evidence
  add constraint st_report_evidence_recorder_membership_fk
  foreign key (organization_id, recorded_by)
  references public.organization_memberships (organization_id, profile_id) on delete restrict;
alter table public.custom_kpi_binding_evidence
  add constraint custom_kpi_binding_evidence_recorder_membership_fk
  foreign key (organization_id, recorded_by)
  references public.organization_memberships (organization_id, profile_id) on delete restrict;
alter table public.audit_events
  add constraint audit_events_actor_membership_fk
  foreign key (organization_id, actor_profile_id)
  references public.organization_memberships (organization_id, profile_id) on delete restrict;

create or replace function public.is_active_organization_governor(
  target_organization_id uuid,
  target_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_profile_id is not null and exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.organization_id = target_organization_id
      and membership.profile_id = target_profile_id
      and membership.status = 'active'
      and membership.role in ('owner', 'admin')
      and organization.status = 'active'
  );
$$;
revoke all on function public.is_active_organization_governor(uuid, uuid) from public;

-- ---------- Membership governance ----------

create or replace function public.enforce_membership_governance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  target_organization_id uuid := coalesce(new.organization_id, old.organization_id);
  removing_active_owner boolean := false;
begin
  -- Serialize owner-removal decisions per organization so two concurrent transactions
  -- cannot each remove a different owner after observing the other one.
  perform 1
  from public.organizations organization
  where organization.id = target_organization_id
  for update;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.profile_id is distinct from old.profile_id then
      raise exception 'Membership organization/profile identity is immutable';
    end if;
    removing_active_owner := old.role = 'owner' and old.status = 'active'
      and (new.role <> 'owner' or new.status <> 'active');
  elsif tg_op = 'DELETE' then
    removing_active_owner := old.role = 'owner' and old.status = 'active';
  end if;

  -- A null auth.uid() is reserved for trusted service-role bootstrap/migrations. It skips
  -- actor authorization, but never skips tenant identity or last-owner invariants.
  if actor_id is not null then
    select membership.role into actor_role
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.profile_id = actor_id
      and membership.status = 'active';

    if actor_role not in ('owner', 'admin') then
      raise exception 'An active organization owner or admin is required to manage memberships';
    end if;

    if tg_op = 'INSERT' then
      if new.role in ('owner', 'admin') and actor_role <> 'owner' then
        raise exception 'Only owners may grant owner or admin membership';
      end if;
    elsif tg_op = 'UPDATE' then
      if old.role in ('owner', 'admin') or new.role in ('owner', 'admin') then
        if actor_role <> 'owner' then
          raise exception 'Only owners may modify owner or admin memberships';
        end if;
      end if;
      if actor_id = old.profile_id and actor_role = 'admin'
         and old.role is distinct from new.role then
        raise exception 'Admins may not promote or change their own role';
      end if;
    elsif tg_op = 'DELETE' then
      if old.role in ('owner', 'admin') and actor_role <> 'owner' then
        raise exception 'Only owners may delete owner or admin memberships';
      end if;
    end if;
  end if;

  if removing_active_owner and not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.role = 'owner'
      and membership.status = 'active'
      and membership.id <> old.id
  ) then
    raise exception 'An organization must retain at least one active owner';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_membership_governance() from public;

drop trigger if exists organization_memberships_10_governance on public.organization_memberships;
create trigger organization_memberships_10_governance
before insert or update or delete on public.organization_memberships
for each row execute function public.enforce_membership_governance();

-- ---------- Fingerprint invalidation and approval provenance ----------

create or replace function public.govern_report_source_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  -- Trigger 20 has already computed NEW.canonical_source_fingerprint.
  if tg_op = 'UPDATE'
     and new.canonical_source_fingerprint is distinct from old.canonical_source_fingerprint then
    new.lifecycle := 'draft';
    new.status := 'active';
    new.verification := 'declared';
    new.inspected_at := null;
    new.observed_schema_fingerprint := null;
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  if new.lifecycle = 'approved'
     and (tg_op = 'INSERT' or old.lifecycle is distinct from 'approved') then
    if actor_id is not null then
      if not public.is_active_organization_governor(new.organization_id, actor_id) then
        raise exception 'Report approval requires an active owner/admin in the same organization';
      end if;
      new.approved_by := actor_id;
    elsif not public.is_active_organization_governor(new.organization_id, new.approved_by) then
      raise exception 'Service-role report approval requires a valid active same-organization owner/admin attribution';
    end if;
    new.approved_at := pg_catalog.clock_timestamp();
  elsif tg_op = 'UPDATE' and old.lifecycle = 'approved' and new.lifecycle in ('approved', 'archived') then
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  elsif new.lifecycle <> 'approved' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.govern_report_source_approval() from public;

drop trigger if exists service_titan_report_sources_25_govern_approval on public.service_titan_report_sources;
create trigger service_titan_report_sources_25_govern_approval
before insert or update on public.service_titan_report_sources
for each row execute function public.govern_report_source_approval();

-- A saved-report binding embeds the report fingerprint in its own fingerprint. Refresh
-- dependent bindings after the report row is visible so an upstream contract change also
-- downgrades every approved binding and invalidates its old evidence.
create or replace function public.refresh_bindings_after_report_contract_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.canonical_source_fingerprint is distinct from old.canonical_source_fingerprint then
    update public.custom_kpi_location_bindings binding
    set updated_at = pg_catalog.clock_timestamp()
    where binding.organization_id = new.organization_id
      and binding.report_source_id = new.id
      and binding.source_method = 'saved_report';
  end if;
  return new;
end;
$$;
revoke all on function public.refresh_bindings_after_report_contract_change() from public;

drop trigger if exists service_titan_report_sources_40_refresh_bindings on public.service_titan_report_sources;
create trigger service_titan_report_sources_40_refresh_bindings
after update on public.service_titan_report_sources
for each row execute function public.refresh_bindings_after_report_contract_change();

create or replace function public.govern_kpi_binding_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  -- Trigger 10 has already recomputed the binding fingerprint.
  if tg_op = 'UPDATE'
     and new.canonical_source_fingerprint is distinct from old.canonical_source_fingerprint then
    new.approval_status := 'draft';
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  if new.approval_status = 'approved'
     and (tg_op = 'INSERT' or old.approval_status is distinct from 'approved') then
    if actor_id is not null then
      if not public.is_active_organization_governor(new.organization_id, actor_id) then
        raise exception 'Binding approval requires an active owner/admin in the same organization';
      end if;
      new.approved_by := actor_id;
    elsif not public.is_active_organization_governor(new.organization_id, new.approved_by) then
      raise exception 'Service-role binding approval requires a valid active same-organization owner/admin attribution';
    end if;
    new.approved_at := pg_catalog.clock_timestamp();
  elsif tg_op = 'UPDATE' and old.approval_status = 'approved'
        and new.approval_status in ('approved', 'archived') then
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  elsif new.approval_status <> 'approved' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.govern_kpi_binding_approval() from public;

drop trigger if exists custom_kpi_bindings_15_govern_approval on public.custom_kpi_location_bindings;
create trigger custom_kpi_bindings_15_govern_approval
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.govern_kpi_binding_approval();

-- ---------- Published-version provenance and immutability ----------

create or replace function public.govern_kpi_definition_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if new.lifecycle = 'published'
     and (tg_op = 'INSERT' or old.lifecycle is distinct from 'published') then
    if actor_id is not null then
      if not public.is_active_organization_governor(new.organization_id, actor_id) then
        raise exception 'KPI publication requires an active owner/admin in the same organization';
      end if;
      new.approved_by := actor_id;
    elsif not public.is_active_organization_governor(new.organization_id, new.approved_by) then
      raise exception 'Service-role KPI publication requires a valid active same-organization owner/admin attribution';
    end if;
    new.approved_at := pg_catalog.clock_timestamp();
    new.published_at := pg_catalog.clock_timestamp();
  elsif tg_op = 'UPDATE' and old.lifecycle = 'published' and new.lifecycle in ('published', 'archived') then
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
    new.published_at := old.published_at;
  elsif new.lifecycle <> 'published' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.govern_kpi_definition_approval() from public;

drop trigger if exists custom_kpi_definitions_20_approval_provenance on public.custom_kpi_definitions;
create trigger custom_kpi_definitions_20_approval_provenance
before insert or update on public.custom_kpi_definitions
for each row execute function public.govern_kpi_definition_approval();

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

  if old.lifecycle = 'published' then
    if new.lifecycle not in ('published', 'archived') then
      raise exception 'Published KPI versions may only remain published or be archived; create a new version';
    end if;
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'updated_at']) then
      raise exception 'Published KPI versions are immutable; create a new version';
    end if;
  elsif old.lifecycle = 'archived' then
    if (pg_catalog.to_jsonb(new) - 'updated_at')
       is distinct from (pg_catalog.to_jsonb(old) - 'updated_at') then
      raise exception 'Archived KPI versions are immutable';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.reject_published_governed_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.lifecycle in ('published', 'archived') then
    raise exception 'Published or archived % rows cannot be deleted; archive published rows and create a new version', tg_table_name;
  end if;
  return old;
end;
$$;
revoke all on function public.reject_published_governed_delete() from public;

drop trigger if exists custom_kpi_definitions_10_reject_governed_delete on public.custom_kpi_definitions;
create trigger custom_kpi_definitions_10_reject_governed_delete
before delete on public.custom_kpi_definitions
for each row execute function public.reject_published_governed_delete();

create or replace function public.govern_kpi_target_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if new.lifecycle = 'published'
     and (tg_op = 'INSERT' or old.lifecycle is distinct from 'published') then
    if actor_id is not null then
      if not public.is_active_organization_governor(new.organization_id, actor_id) then
        raise exception 'KPI target publication requires an active owner/admin in the same organization';
      end if;
      new.approved_by := actor_id;
    elsif not public.is_active_organization_governor(new.organization_id, new.approved_by) then
      raise exception 'Service-role target publication requires a valid active same-organization owner/admin attribution';
    end if;
    new.approved_at := pg_catalog.clock_timestamp();
  elsif tg_op = 'UPDATE' and old.lifecycle = 'published' and new.lifecycle in ('published', 'archived') then
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  elsif new.lifecycle <> 'published' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.govern_kpi_target_approval() from public;

create or replace function public.protect_kpi_target_governance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.location_id is distinct from old.location_id
     or new.metric_key is distinct from old.metric_key
     or new.version is distinct from old.version
     or new.effective_from is distinct from old.effective_from then
    raise exception 'KPI target organization/scope/key/version/effective identity is immutable; create a new version';
  end if;
  if old.lifecycle = 'published' then
    if new.lifecycle not in ('published', 'archived') then
      raise exception 'Published KPI targets may only be archived; create a new version';
    end if;
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'updated_at']) then
      raise exception 'Published KPI targets are immutable; create a new version';
    end if;
  elsif old.lifecycle = 'archived' then
    if (pg_catalog.to_jsonb(new) - 'updated_at')
       is distinct from (pg_catalog.to_jsonb(old) - 'updated_at') then
      raise exception 'Archived KPI targets are immutable';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_kpi_target_governance() from public;

drop trigger if exists kpi_targets_10_protect_governance on public.kpi_targets;
create trigger kpi_targets_10_protect_governance
before update on public.kpi_targets
for each row execute function public.protect_kpi_target_governance();
drop trigger if exists kpi_targets_20_approval_provenance on public.kpi_targets;
create trigger kpi_targets_20_approval_provenance
before insert or update on public.kpi_targets
for each row execute function public.govern_kpi_target_approval();
drop trigger if exists kpi_targets_30_reject_governed_delete on public.kpi_targets;
create trigger kpi_targets_30_reject_governed_delete
before delete on public.kpi_targets
for each row execute function public.reject_published_governed_delete();

create or replace function public.protect_layout_template_governance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.template_key is distinct from old.template_key
     or new.version is distinct from old.version then
    raise exception 'Layout organization/key/version identity is immutable; create a new version';
  end if;
  if old.lifecycle = 'published' then
    if new.lifecycle not in ('published', 'archived') then
      raise exception 'Published layout templates may only be archived; create a new version';
    end if;
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'updated_at']) then
      raise exception 'Published layout templates are immutable; create a new version';
    end if;
  elsif old.lifecycle = 'archived' then
    if (pg_catalog.to_jsonb(new) - 'updated_at')
       is distinct from (pg_catalog.to_jsonb(old) - 'updated_at') then
      raise exception 'Archived layout templates are immutable';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_layout_template_governance() from public;

drop trigger if exists layout_templates_10_protect_governance on public.layout_templates;
create trigger layout_templates_10_protect_governance
before update on public.layout_templates
for each row execute function public.protect_layout_template_governance();
drop trigger if exists layout_templates_20_reject_governed_delete on public.layout_templates;
create trigger layout_templates_20_reject_governed_delete
before delete on public.layout_templates
for each row execute function public.reject_published_governed_delete();

-- ---------- Table ACL reset ----------

-- Start from an explicit clean slate. authenticated receives only ordinary DML; it never
-- receives TRUNCATE, REFERENCES, or TRIGGER. Worker fact tables remain SELECT-only to
-- authenticated even though service_role can bypass RLS for trusted server writes.
revoke all privileges on all tables in schema public from public;
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all tables in schema public from authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.service_titan_report_evidence from authenticated;
revoke insert, update, delete on public.custom_kpi_binding_evidence from authenticated;
revoke insert, update, delete on public.kpi_observations from authenticated;
revoke insert, update, delete on public.audit_events from authenticated;
revoke truncate, references, trigger on all tables in schema public from authenticated;

comment on table public.audit_events is
  'Append-only configuration audit ledger. Connection snapshots retain only the recognized opaque secret_reference identifier, never the resolved secret.';
comment on table public.organization_memberships is
  'Membership governance is trigger-enforced: only owners manage owner/admin roles and every organization retains an active owner.';
comment on table public.custom_kpi_definitions is
  'Versioned governed KPI definitions. Published rows are immutable except for archival; republishing requires a new version row.';
comment on table public.kpi_targets is
  'Versioned governed KPI targets. Published rows are immutable except for archival; changed targets require a new version row.';
comment on table public.layout_templates is
  'Versioned governed layouts. Published rows are immutable except for archival; changed layouts require a new version row.';
