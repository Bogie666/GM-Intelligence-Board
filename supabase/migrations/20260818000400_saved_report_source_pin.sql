-- Pin approved saved-report bindings to the exact report-source fingerprint and
-- make approved source/binding contracts immutable. Workers must compare the
-- current source fingerprint with the pinned value before requesting provider data.

alter table public.custom_kpi_location_bindings
  add column approved_report_source_fingerprint text;

update public.custom_kpi_location_bindings binding
set approved_report_source_fingerprint = source.canonical_source_fingerprint
from public.service_titan_report_sources source
where binding.source_method = 'saved_report'
  and source.id = binding.report_source_id
  and source.organization_id = binding.organization_id
  and source.connection_id = binding.connection_id
  and source.service_titan_tenant_id = binding.service_titan_tenant_id;

alter table public.custom_kpi_location_bindings
  add constraint custom_kpi_binding_report_source_pin_check check (
    (source_method = 'saved_report' and approved_report_source_fingerprint is not null
      and pg_catalog.btrim(approved_report_source_fingerprint) <> '')
    or
    (source_method is distinct from 'saved_report' and approved_report_source_fingerprint is null)
  ) not valid;

alter table public.custom_kpi_location_bindings
  validate constraint custom_kpi_binding_report_source_pin_check;

create or replace function public.pin_and_protect_saved_report_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_source_fingerprint text;
begin
  if tg_op = 'UPDATE' and old.approval_status = 'archived' then
    raise exception 'Archived KPI bindings are immutable';
  end if;

  if tg_op = 'UPDATE' and old.approval_status = 'approved' then
    if new.approval_status not in ('approved', 'archived') then
      raise exception 'Approved KPI bindings may only remain approved or be archived';
    end if;
    if (pg_catalog.to_jsonb(new) - array['approval_status', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['approval_status', 'updated_at']) then
      raise exception 'Approved KPI bindings are immutable; create a new binding contract';
    end if;
    return new;
  end if;

  if new.source_method = 'saved_report' then
    select source.canonical_source_fingerprint
      into current_source_fingerprint
    from public.service_titan_report_sources source
    where source.id = new.report_source_id
      and source.organization_id = new.organization_id
      and source.connection_id = new.connection_id
      and source.service_titan_tenant_id = new.service_titan_tenant_id;
    if current_source_fingerprint is null then
      raise exception 'Saved-report source fingerprint is unavailable';
    end if;
    new.approved_report_source_fingerprint := current_source_fingerprint;
  else
    new.approved_report_source_fingerprint := null;
  end if;
  return new;
end;
$$;

revoke all on function public.pin_and_protect_saved_report_binding() from public;
revoke all on function public.pin_and_protect_saved_report_binding() from anon;
revoke all on function public.pin_and_protect_saved_report_binding() from authenticated;

create trigger custom_kpi_bindings_05_source_pin
before insert or update on public.custom_kpi_location_bindings
for each row execute function public.pin_and_protect_saved_report_binding();

create or replace function public.protect_approved_report_source_contract()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.lifecycle = 'archived' then
    raise exception 'Archived ServiceTitan report sources are immutable';
  end if;
  if old.lifecycle = 'approved' then
    if new.lifecycle not in ('approved', 'archived') then
      raise exception 'Approved ServiceTitan report sources may only remain approved or be archived';
    end if;
    if (pg_catalog.to_jsonb(new) - array['lifecycle', 'status', 'updated_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['lifecycle', 'status', 'updated_at']) then
      raise exception 'Approved ServiceTitan report contracts are immutable; register a new source';
    end if;
  end if;
  return new;
end;
$$;

create trigger service_titan_report_sources_05_protect_approved
before update on public.service_titan_report_sources
for each row execute function public.protect_approved_report_source_contract();
