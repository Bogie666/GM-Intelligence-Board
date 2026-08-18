-- Catalog/security verification for all GM Intelligence Board migrations.
-- Run after migrations with a privileged connection and ON_ERROR_STOP enabled.
-- Catalog assertions are followed by disposable behavioral fixtures inside this transaction.
-- The final ROLLBACK guarantees that the script leaves no users or tenant data behind.

begin;

do $$
declare
  expected_tables constant text[] := array[
    'organizations',
    'locations',
    'profiles',
    'organization_memberships',
    'service_titan_connections',
    'service_titan_connection_locations',
    'service_titan_report_sources',
    'service_titan_report_evidence',
    'custom_kpi_definitions',
    'custom_kpi_location_bindings',
    'custom_kpi_binding_evidence',
    'kpi_observations',
    'kpi_targets',
    'layout_templates',
    'profile_layouts',
    'audit_events',
    'schema_releases',
    'pilot_auth_email_authorizations',
    'portfolios',
    'portfolio_memberships',
    'portfolio_organizations',
    'portfolio_audit_events'
  ];
  worker_read_only_tables constant text[] := array[
    'service_titan_report_evidence',
    'custom_kpi_binding_evidence',
    'kpi_observations',
    'audit_events'
  ];
  rpc_only_tables constant text[] := array[
    'schema_releases',
    'pilot_auth_email_authorizations',
    'portfolios',
    'portfolio_memberships',
    'portfolio_organizations',
    'portfolio_audit_events'
  ];
  rpc_managed_tables constant text[] := array[
    'service_titan_connections',
    'service_titan_connection_locations'
  ];
  missing_tables text[];
  rls_disabled text[];
  anon_policy_count integer;
  forbidden_worker_write_policy_count integer;
  suspicious_columns text[];
  missing_trigger_count integer;
  missing_constraint_count integer;
  anon_acl_count integer;
  public_acl_count integer;
  forbidden_authenticated_acl_count integer;
  missing_authenticated_select_count integer;
  wrong_authenticated_dml_count integer;
  missing_release_policy_count integer;
  unexpected_anon_function_count integer;
  unexpected_authenticated_function_count integer;
  release_ready boolean;
  release_marker text;
begin
  select pg_catalog.array_agg(name order by name)
    into missing_tables
  from pg_catalog.unnest(expected_tables) as name
  where not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = name
      and relation.relkind in ('r', 'p')
  );
  if missing_tables is not null then
    raise exception 'Missing expected public tables: %', missing_tables;
  end if;

  -- Assert every ordinary public table, not merely the current expected list.
  select pg_catalog.array_agg(relation.relname order by relation.relname)
    into rls_disabled
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and not relation.relrowsecurity;
  if rls_disabled is not null then
    raise exception 'RLS is disabled on public tables: %', rls_disabled;
  end if;

  select count(*) into anon_policy_count
  from pg_catalog.pg_policies policy
  where policy.schemaname = 'public'
    and (policy.roles @> array['anon']::name[] or policy.roles @> array['public']::name[]);
  if anon_policy_count <> 0 then
    raise exception 'Found % public/anon RLS policies; expected none', anon_policy_count;
  end if;

  select count(*) into forbidden_worker_write_policy_count
  from pg_catalog.pg_policies policy
  where policy.schemaname = 'public'
    and policy.tablename = any (worker_read_only_tables)
    and policy.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if forbidden_worker_write_policy_count <> 0 then
    raise exception 'Found % authenticated/public write policies on worker-only tables', forbidden_worker_write_policy_count;
  end if;

  select pg_catalog.array_agg(table_name || '.' || column_name order by table_name, column_name)
    into suspicious_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = any (expected_tables)
    and column_name ~* '(access_?token|refresh_?token|client_?secret|app_?key|api_?key|password|authorization|credential)';
  if suspicious_columns is not null then
    raise exception 'Credential-like columns are forbidden: %', suspicious_columns;
  end if;

  -- No direct table privilege may leak through anon or PUBLIC.
  select count(*) into anon_acl_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and pg_catalog.has_table_privilege(
      'anon', relation.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    );
  if anon_acl_count <> 0 then
    raise exception 'anon has privileges on % public tables; expected none', anon_acl_count;
  end if;

  select count(*) into public_acl_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
  ) acl
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and acl.grantee = 0;
  if public_acl_count <> 0 then
    raise exception 'PUBLIC has % direct public-table ACL entries; expected none', public_acl_count;
  end if;

  select count(*) into forbidden_authenticated_acl_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and pg_catalog.has_table_privilege('authenticated', relation.oid, 'TRUNCATE,REFERENCES,TRIGGER');
  if forbidden_authenticated_acl_count <> 0 then
    raise exception 'authenticated has TRUNCATE/REFERENCES/TRIGGER on % public tables', forbidden_authenticated_acl_count;
  end if;

  select count(*) into missing_authenticated_select_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and not (relation.relname = any (rpc_only_tables))
    and not (relation.relname = any (rpc_managed_tables))
    and not pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT');
  if missing_authenticated_select_count <> 0 then
    raise exception 'authenticated lacks SELECT on % RLS-protected public tables', missing_authenticated_select_count;
  end if;

  select count(*) into wrong_authenticated_dml_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and (
      (relation.relname = any (rpc_only_tables) and
        pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE'))
      or
      (relation.relname = any (worker_read_only_tables) and
        pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT,UPDATE,DELETE'))
      or
      (relation.relname = any (rpc_managed_tables) and
        pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT,UPDATE,DELETE'))
      or
      (not (relation.relname = any (worker_read_only_tables || rpc_only_tables || rpc_managed_tables)) and not (
        pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')
        and pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE')
        and pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE')
      ))
    );
  if wrong_authenticated_dml_count <> 0 then
    raise exception 'authenticated DML ACL boundary is wrong on % public tables', wrong_authenticated_dml_count;
  end if;

  if pg_catalog.has_table_privilege('authenticated', 'public.service_titan_connections', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'secret_reference', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'id', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'organization_id', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'service_titan_tenant_id', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'display_name', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'environment', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'capabilities', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'status', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'last_validated_at', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'created_at', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.service_titan_connections', 'updated_at', 'SELECT') then
    raise exception 'service_titan_connections safe-column SELECT boundary is incorrect';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.schema_releases', 'SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('authenticated', 'public.schema_releases', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'schema_releases must be accessible only through the readiness RPC';
  end if;

  if not pg_catalog.has_function_privilege('anon', 'public.get_release_readiness()', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.get_release_readiness()', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.bootstrap_tenant_owner(uuid,text,text,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.bootstrap_tenant_owner(uuid,text,text,text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.bootstrap_tenant_owner(uuid,text,text,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.remove_empty_qa_tenant(uuid,uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.remove_empty_qa_tenant(uuid,uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.finalize_brand_portfolio_onboarding(uuid,uuid,uuid,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.finalize_brand_portfolio_onboarding(uuid,uuid,uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.prepare_empty_qa_brand_removal(uuid,uuid,uuid,uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.prepare_empty_qa_brand_removal(uuid,uuid,uuid,uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.remove_empty_qa_brand_from_portfolio(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.remove_empty_qa_brand_from_portfolio(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.register_service_titan_connection(uuid,text,text,text,text,uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.register_service_titan_connection(uuid,text,text,text,text,uuid)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.disable_service_titan_connection(uuid,uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.disable_service_titan_connection(uuid,uuid)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.can_view_kpi_definition(uuid,uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.can_view_kpi_definition(uuid,uuid)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.can_view_current_kpi_observation(uuid,uuid,text,bigint,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.can_view_current_kpi_observation(uuid,uuid,text,bigint,text)', 'EXECUTE') then
    raise exception 'bootstrap/readiness/QA teardown/connection function ACL boundary is incorrect';
  end if;

  select readiness.ready, readiness.release_marker
    into release_ready, release_marker
  from public.get_release_readiness() readiness;
  if release_ready is distinct from true
     or release_marker is distinct from '20260818001200_atomic_qa_portfolio_cleanup' then
    raise exception 'release readiness marker is incorrect: ready %, marker %', release_ready, release_marker;
  end if;

  select count(*) into unexpected_anon_function_count
  from pg_catalog.pg_proc function
  join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
  where namespace.nspname = 'public'
    and pg_catalog.has_function_privilege('anon', function.oid, 'EXECUTE')
    and function.oid <> 'public.get_release_readiness()'::pg_catalog.regprocedure;
  if unexpected_anon_function_count <> 0 then
    raise exception 'anon can execute % unexpected public functions', unexpected_anon_function_count;
  end if;

  select count(*) into unexpected_authenticated_function_count
  from pg_catalog.pg_proc function
  join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
  where namespace.nspname = 'public'
    and pg_catalog.has_function_privilege('authenticated', function.oid, 'EXECUTE')
    and not (function.oid = any (array[
      'public.get_release_readiness()'::pg_catalog.regprocedure,
      'public.is_active_organization_member(uuid)'::pg_catalog.regprocedure,
      'public.has_organization_role(uuid,text[])'::pg_catalog.regprocedure,
      'public.can_read_profile(uuid)'::pg_catalog.regprocedure,
      'public.can_view_kpi_definition(uuid,uuid)'::pg_catalog.regprocedure,
      'public.can_view_current_kpi_observation(uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure,
      'public.register_service_titan_connection(uuid,text,text,text,text,uuid)'::pg_catalog.regprocedure,
      'public.disable_service_titan_connection(uuid,uuid)'::pg_catalog.regprocedure,
      'public.has_portfolio_access()'::pg_catalog.regprocedure,
      'public.can_access_portfolio_brand(uuid)'::pg_catalog.regprocedure,
      'public.get_portfolio_overview()'::pg_catalog.regprocedure,
      'public.is_finite_numeric(numeric)'::pg_catalog.regprocedure,
      'public.jsonb_has_forbidden_credential_keys(jsonb)'::pg_catalog.regprocedure
    ]));
  if unexpected_authenticated_function_count <> 0 then
    raise exception 'authenticated can execute % unexpected public functions', unexpected_authenticated_function_count;
  end if;

  select count(*) into missing_release_policy_count
  from (
    values
      ('custom_kpi_definitions', 'custom_kpi_definitions_role_read'),
      ('custom_kpi_location_bindings', 'custom_kpi_bindings_role_read'),
      ('service_titan_report_sources', 'st_report_sources_admin_read'),
      ('service_titan_report_evidence', 'st_report_evidence_admin_read'),
      ('custom_kpi_binding_evidence', 'custom_kpi_binding_evidence_admin_read'),
      ('kpi_observations', 'kpi_observations_current_role_read')
  ) as expected(table_name, policy_name)
  where not exists (
    select 1
    from pg_catalog.pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename = expected.table_name
      and policy.policyname = expected.policy_name
      and policy.cmd = 'SELECT'
      and policy.roles @> array['authenticated']::name[]
  );
  if missing_release_policy_count <> 0 then
    raise exception 'Missing % production-release read policies', missing_release_policy_count;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any (array[
        'govern_report_source_approval',
        'govern_kpi_binding_approval',
        'govern_kpi_definition_approval',
        'govern_kpi_target_approval'
      ])
      and not procedure.prosecdef
  ) then
    raise exception 'governor-calling trigger functions must be SECURITY DEFINER';
  end if;

  select count(*) into missing_trigger_count
  from (
    values
      ('organization_memberships', 'organization_memberships_10_governance'),
      ('service_titan_connections', 'service_titan_connections_protect_identity'),
      ('service_titan_report_sources', 'service_titan_report_sources_05_protect_approved'),
      ('service_titan_report_sources', 'service_titan_report_sources_10_protect_identity'),
      ('service_titan_report_sources', 'service_titan_report_sources_25_govern_approval'),
      ('service_titan_report_sources', 'service_titan_report_sources_40_refresh_bindings'),
      ('service_titan_report_evidence', 'st_report_evidence_append_only'),
      ('custom_kpi_definitions', 'custom_kpi_definitions_10_reject_governed_delete'),
      ('custom_kpi_definitions', 'custom_kpi_definitions_20_approval_provenance'),
      ('custom_kpi_location_bindings', 'custom_kpi_bindings_05_source_pin'),
      ('custom_kpi_location_bindings', 'custom_kpi_bindings_15_govern_approval'),
      ('custom_kpi_binding_evidence', 'custom_kpi_binding_evidence_append_only'),
      ('kpi_observations', 'kpi_observations_bind_identity'),
      ('kpi_observations', 'kpi_observations_append_only'),
      ('kpi_targets', 'kpi_targets_10_protect_governance'),
      ('kpi_targets', 'kpi_targets_20_approval_provenance'),
      ('kpi_targets', 'kpi_targets_30_reject_governed_delete'),
      ('layout_templates', 'layout_templates_10_protect_governance'),
      ('layout_templates', 'layout_templates_20_reject_governed_delete'),
      ('audit_events', 'audit_events_append_only')
  ) as expected(table_name, trigger_name)
  where not exists (
    select 1
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = expected.table_name
      and trigger.tgname = expected.trigger_name
      and not trigger.tgisinternal
  );
  if missing_trigger_count <> 0 then
    raise exception 'Missing % required governance/immutability/append-only triggers', missing_trigger_count;
  end if;

  select count(*) into missing_constraint_count
  from (
    values
      ('service_titan_connections', 'service_titan_connections_secret_reference_format'),
      ('service_titan_connections', 'service_titan_connections_operator_resolvable_secret_check'),
      ('service_titan_report_sources', 'st_report_sources_approver_membership_fk'),
      ('service_titan_report_evidence', 'st_report_evidence_recorder_membership_fk'),
      ('custom_kpi_definitions', 'custom_kpi_definition_owner_membership_fk'),
      ('custom_kpi_definitions', 'custom_kpi_definition_approver_membership_fk'),
      ('custom_kpi_definitions', 'custom_kpi_definition_approval_fields'),
      ('custom_kpi_location_bindings', 'custom_kpi_binding_approver_membership_fk'),
      ('custom_kpi_location_bindings', 'custom_kpi_binding_report_source_pin_check'),
      ('custom_kpi_binding_evidence', 'custom_kpi_binding_evidence_recorder_membership_fk'),
      ('kpi_observations', 'kpi_observations_idempotency_sha256_check'),
      ('kpi_targets', 'kpi_target_owner_membership_fk'),
      ('kpi_targets', 'kpi_target_approver_membership_fk'),
      ('audit_events', 'audit_events_actor_membership_fk'),
      ('audit_events', 'audit_events_no_credentials')
  ) as expected(table_name, constraint_name)
  where not exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = expected.table_name
      and constraint_record.conname = expected.constraint_name
      and constraint_record.convalidated
  );
  if missing_constraint_count <> 0 then
    raise exception 'Missing or unvalidated % required hardening constraints', missing_constraint_count;
  end if;

  if public.is_valid_secret_reference('plain-token-value')
     or public.is_valid_secret_reference('https://secret.example/value')
     or not public.is_valid_secret_reference('gcp-secret://projects/demo/secrets/st-key/versions/latest')
     or not public.is_valid_secret_reference('supabase-vault://f15f7d3e-1111-4444-8888-7d7d7d7d7d7d')
     or not public.is_valid_secret_reference('env://SERVICETITAN_SECRET_REF') then
    raise exception 'Opaque secret-reference scheme validation is incorrect';
  end if;

  if not public.is_operator_resolvable_secret_reference('gcp-secret://projects/demo/secrets/st-key/versions/latest')
     or not public.is_operator_resolvable_secret_reference('env://SERVICETITAN_SECRET_REF')
     or public.is_operator_resolvable_secret_reference('supabase-vault://f15f7d3e-1111-4444-8888-7d7d7d7d7d7d')
     or public.is_operator_resolvable_secret_reference('env://lowercase')
     or public.is_operator_resolvable_secret_reference('gcp-secret://projects/demo/secrets/st-key/versions/zero') then
    raise exception 'Operator-resolvable secret-reference validation is incorrect';
  end if;

  if not public.jsonb_has_forbidden_credential_keys('{"secret_reference":"env://REF"}'::jsonb)
     or not public.jsonb_has_forbidden_credential_keys('{"nested":{"token":"ordinary-label"}}'::jsonb)
     or not public.jsonb_has_forbidden_credential_keys('{"label":"Bearer abcdefghijklmnop"}'::jsonb)
     or public.jsonb_has_forbidden_credential_keys('{"label":"daily revenue summary"}'::jsonb) then
    raise exception 'Recursive JSON credential rejection is incorrect';
  end if;

  if not public.audit_state_has_forbidden_credentials(
       '{"id":"00000000-0000-0000-0000-000000000000","secret_reference":"env://ST_REF"}'::jsonb,
       'service_titan_connections'
     )
     or not public.audit_state_has_forbidden_credentials(
       '{"secret_reference":"env://ST_REF"}'::jsonb,
       'other_table'
     ) then
    raise exception 'Audit secret-reference rejection is incorrect';
  end if;
end
$$;

-- ---------- Disposable behavioral/RLS verification ----------

-- Fixed UUIDs make failures reproducible. These rows exist only until the final ROLLBACK.
insert into public.pilot_auth_email_authorizations (email, expires_at) values
  ('schema-owner-a@example.invalid', pg_catalog.now() + interval '5 minutes'),
  ('schema-owner-b@example.invalid', pg_catalog.now() + interval '5 minutes'),
  ('schema-bootstrap@example.invalid', pg_catalog.now() + interval '5 minutes'),
  ('schema-platform-operator@example.invalid', pg_catalog.now() + interval '5 minutes');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'schema-owner-a@example.invalid', '', pg_catalog.now(),
   '{"provider":"email","providers":["email"]}', '{}', pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'schema-owner-b@example.invalid', '', pg_catalog.now(),
   '{"provider":"email","providers":["email"]}', '{}', pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'schema-bootstrap@example.invalid', '', pg_catalog.now(),
   '{"provider":"email","providers":["email"]}', '{}', pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'schema-platform-operator@example.invalid', '', pg_catalog.now(),
   '{"provider":"email","providers":["email"]}', '{}', pg_catalog.now(), pg_catalog.now(), '', '', '', '');

insert into public.profiles (id, display_name) values
  ('10000000-0000-4000-8000-000000000001', 'Schema Owner A'),
  ('20000000-0000-4000-8000-000000000002', 'Schema Owner B'),
  ('40000000-0000-4000-8000-000000000004', 'Schema Platform Operator');

insert into public.organizations (id, slug, name) values
  ('a0000000-0000-4000-8000-000000000001', 'schema-tenant-a', 'Schema Tenant A'),
  ('b0000000-0000-4000-8000-000000000002', 'schema-tenant-b', 'Schema Tenant B');

insert into public.organization_memberships (
  id, organization_id, profile_id, role, status, joined_at
) values
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'owner', 'active', pg_catalog.now()),
  ('b2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000002', 'owner', 'active', pg_catalog.now());

insert into public.locations (
  id, organization_id, location_key, brand_name, display_name, timezone
) values
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'tenant-a-main', 'Tenant A', 'Tenant A Main', 'America/New_York'),
  ('b3000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   'tenant-b-main', 'Tenant B', 'Tenant B Main', 'America/Chicago'),
  ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'tenant-a-observation', 'Tenant A', 'Tenant A Observation', 'America/New_York');

-- Cross-layer observation fixture: prove the deployed 64-hex idempotency contract accepts
-- a fully governed endpoint-recipe observation instead of validating worker/schema formats
-- independently.
insert into public.service_titan_connections (
  id, organization_id, service_titan_tenant_id, display_name, environment,
  secret_reference, status, last_validated_at
) values (
  'a3000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'schema-observation-st', 'Schema Observation Connection', 'integration',
  'gcp-secret://projects/schema/secrets/observation/versions/latest', 'ready', pg_catalog.now()
);
insert into public.service_titan_connection_locations (
  organization_id, connection_id, location_id
) values (
  'a0000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000003'
);
insert into public.custom_kpi_definitions (
  id, organization_id, kpi_key, type, lifecycle, title, business_definition,
  owner_profile_id, section, value_kind, direction, scope_mode, viewer_roles,
  refresh_cadence, stale_after_hours, release_note, validation_results, validated_at,
  approved_by
) values (
  'a4000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'schema-observation-kpi', 'service_titan', 'published', 'Schema Observation KPI',
  'Rollback-only governed observation verification',
  '10000000-0000-4000-8000-000000000001', 'executive', 'number', 'higher',
  'selected_locations', '["owner"]'::jsonb, '1h', 4, 'Schema verification release',
  '[{"status":"pass"}]'::jsonb, pg_catalog.now(),
  '10000000-0000-4000-8000-000000000001'
);
insert into public.custom_kpi_location_bindings (
  id, organization_id, kpi_definition_id, location_id, connection_id,
  service_titan_tenant_id, source_method, endpoint_recipe_id,
  endpoint_recipe_version, refresh_interval, approval_status
) values (
  'a5000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000003',
  'a3000000-0000-4000-8000-000000000001',
  'schema-observation-st', 'endpoint_recipe', 'completed-revenue', 1, '1h', 'draft'
);
insert into public.custom_kpi_binding_evidence (
  organization_id, binding_id, evidence_type, source_fingerprint, status,
  row_count, computed_value, observed_at, recorded_by
)
select
  'a0000000-0000-4000-8000-000000000001', binding.id, 'sample',
  binding.canonical_source_fingerprint, 'pass', 1, 42, pg_catalog.now(),
  '10000000-0000-4000-8000-000000000001'
from public.custom_kpi_location_bindings binding
where binding.id = 'a5000000-0000-4000-8000-000000000001';
insert into public.custom_kpi_binding_evidence (
  organization_id, binding_id, evidence_type, source_fingerprint, status,
  expected_value, reference_value, tolerance, delta, observed_at, recorded_by
)
select
  'a0000000-0000-4000-8000-000000000001', binding.id, 'reconciliation',
  binding.canonical_source_fingerprint, 'pass', 42, 42, 0, 0, pg_catalog.now(),
  '10000000-0000-4000-8000-000000000001'
from public.custom_kpi_location_bindings binding
where binding.id = 'a5000000-0000-4000-8000-000000000001';
update public.custom_kpi_location_bindings
set approval_status = 'approved',
    approved_by = '10000000-0000-4000-8000-000000000001'
where id = 'a5000000-0000-4000-8000-000000000001';
insert into public.kpi_observations (
  organization_id, binding_id, kpi_definition_id, location_id, source_fingerprint,
  source_version, period_start, period_end, observed_at, value, status, confidence,
  idempotency_key, metadata
)
select
  binding.organization_id, binding.id, binding.kpi_definition_id, binding.location_id,
  binding.canonical_source_fingerprint, 1,
  pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour',
  pg_catalog.now(), 42, 'valid', 'high',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"verification":"cross-layer"}'::jsonb
from public.custom_kpi_location_bindings binding
where binding.id = 'a5000000-0000-4000-8000-000000000001';

do $$
begin
  if not exists (
    select 1 from public.kpi_observations observation
    where observation.binding_id = 'a5000000-0000-4000-8000-000000000001'
      and observation.idempotency_key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ) then
    raise exception 'Governed observation/idempotency integration fixture was not materialized';
  end if;
end
$$;

-- Prove service-role bootstrap is transactional/idempotent and guarded QA teardown works.
set local role service_role;
select pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
select pg_catalog.set_config('request.jwt.claim.sub', '', true);
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $bootstrap_behavior$
declare
  first_created boolean;
  second_created boolean;
  first_organization_id uuid;
  second_organization_id uuid;
  shared_user_denied boolean := false;
begin
  select result.created, result.organization_id
    into first_created, first_organization_id
  from public.bootstrap_tenant_owner(
    '30000000-0000-4000-8000-000000000003',
    'schema-bootstrap@example.invalid',
    'Schema Bootstrap Owner',
    'qa-schema-bootstrap',
    'QA Schema Bootstrap'
  ) result;

  select result.created, result.organization_id
    into second_created, second_organization_id
  from public.bootstrap_tenant_owner(
    '30000000-0000-4000-8000-000000000003',
    'schema-bootstrap@example.invalid',
    'Schema Bootstrap Owner',
    'qa-schema-bootstrap',
    'QA Schema Bootstrap'
  ) result;

  if first_created is distinct from true
     or second_created is distinct from false
     or first_organization_id is distinct from second_organization_id then
    raise exception 'service-role tenant bootstrap is not idempotent';
  end if;

  perform public.finalize_brand_portfolio_onboarding(
    'c1000000-0000-4000-8000-000000000001',
    first_organization_id,
    '40000000-0000-4000-8000-000000000004',
    'Schema verification QA portfolio onboarding'
  );
  perform public.grant_portfolio_owner_access(
    'c1000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'Schema verification temporary QA portfolio access'
  );
  perform public.revoke_portfolio_membership(
    'c1000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'Schema verification terminal QA portfolio access'
  );
  insert into public.organization_memberships (organization_id, profile_id, role, status, joined_at)
  values (
    'a0000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'viewer',
    'active',
    pg_catalog.now()
  );
  begin
    perform public.remove_empty_qa_brand_from_portfolio(
      'c1000000-0000-4000-8000-000000000001',
      first_organization_id,
      '30000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000004',
      'qa-schema-bootstrap',
      'Schema verification shared-user rollback'
    );
  exception when raise_exception then
    shared_user_denied := true;
  end;
  if not shared_user_denied
     or not exists (
       select 1 from public.portfolio_organizations attachment
       where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
         and attachment.organization_id = first_organization_id and attachment.status = 'active'
     )
     or not exists (
       select 1 from public.organization_memberships membership
       where membership.organization_id = first_organization_id
         and membership.profile_id = '40000000-0000-4000-8000-000000000004'
     )
     or not exists (
       select 1 from public.portfolio_memberships membership
       where membership.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
         and membership.profile_id = '30000000-0000-4000-8000-000000000003'
         and membership.status = 'revoked'
     ) then
    raise exception 'failed atomic QA teardown did not preserve portfolio and platform-owner state';
  end if;
  delete from public.organization_memberships membership
  where membership.organization_id = 'a0000000-0000-4000-8000-000000000001'
    and membership.profile_id = '30000000-0000-4000-8000-000000000003';

  if not public.remove_empty_qa_brand_from_portfolio(
    'c1000000-0000-4000-8000-000000000001',
    first_organization_id,
    '30000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000004',
    'qa-schema-bootstrap',
    'Schema verification atomic QA teardown'
  ) then
    raise exception 'atomic portfolio QA teardown did not report success';
  end if;
  if exists (
    select 1 from public.portfolio_memberships membership
    where membership.profile_id = '30000000-0000-4000-8000-000000000003'
  ) or not exists (
    select 1 from public.portfolio_audit_events audit
    where audit.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
      and audit.target_profile_id = '30000000-0000-4000-8000-000000000003'
      and audit.event_type = 'portfolio_memberships.delete'
      and audit.before_state ->> 'status' = 'revoked'
  ) then
    raise exception 'atomic QA teardown did not remove only the terminal membership while retaining audit history';
  end if;
  delete from public.organization_memberships membership
  where membership.profile_id = '40000000-0000-4000-8000-000000000004';

  if exists (select 1 from public.organizations where id = first_organization_id)
     or exists (select 1 from public.profiles where id = '30000000-0000-4000-8000-000000000003') then
    raise exception 'guarded QA teardown left tenant rows behind';
  end if;
end
$bootstrap_behavior$;

reset role;

-- Exercise table policies as an actual authenticated owner, not as the migration owner.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
select pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000001"}',
  true
);

do $rls_behavior$
declare
  affected_rows bigint;
  denied boolean := false;
  v_connection_id uuid;
begin
  if (select pg_catalog.count(*) from public.organizations) <> 1
     or not exists (
       select 1 from public.organizations
       where id = 'a0000000-0000-4000-8000-000000000001'
     )
     or exists (
       select 1 from public.organizations
       where id = 'b0000000-0000-4000-8000-000000000002'
     ) then
    raise exception 'authenticated owner organization SELECT isolation failed';
  end if;

  if (select pg_catalog.count(*) from public.locations) <> 2
     or (select pg_catalog.count(*) from public.organization_memberships) <> 1
     or exists (
       select 1 from public.profiles
       where id = '20000000-0000-4000-8000-000000000002'
     ) then
    raise exception 'authenticated owner related-row SELECT isolation failed';
  end if;

  insert into public.locations (
    organization_id, location_key, brand_name, display_name, timezone
  ) values (
    'a0000000-0000-4000-8000-000000000001',
    'owner-created', 'Tenant A', 'Owner Created', 'America/New_York'
  );

  if not exists (select 1 from public.locations where location_key = 'owner-created') then
    raise exception 'authenticated owner same-tenant INSERT failed';
  end if;

  v_connection_id := public.register_service_titan_connection(
    'a0000000-0000-4000-8000-000000000001',
    'schema-tenant-a-st',
    'Schema Tenant A ServiceTitan',
    'integration',
    'gcp-secret://projects/schema/secrets/tenant-a/versions/latest',
    'a2000000-0000-4000-8000-000000000001'
  );
  if v_connection_id is null
     or not exists (
       select 1 from public.service_titan_connection_locations assignment
       where assignment.organization_id = 'a0000000-0000-4000-8000-000000000001'
         and assignment.connection_id = v_connection_id
         and assignment.location_id = 'a2000000-0000-4000-8000-000000000001'
         and assignment.revoked_at is null
     ) then
    raise exception 'atomic same-tenant connection registration failed';
  end if;

  -- Safe connection metadata is readable, but the managed-secret locator is not.
  if not exists (
    select 1
    from public.service_titan_connections connection
    where connection.id = v_connection_id
      and connection.organization_id = 'a0000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'safe connection metadata is not readable by the tenant owner';
  end if;
  denied := false;
  begin
    perform connection.secret_reference
    from public.service_titan_connections connection
    where connection.id = v_connection_id;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'managed-secret locator was readable by authenticated';
  end if;

  if exists (
    select 1
    from public.audit_events event
    where event.resource_table = 'service_titan_connections'
      and event.resource_id = v_connection_id
      and (
        coalesce(event.before_state ? 'secret_reference', false)
        or coalesce(event.after_state ? 'secret_reference', false)
      )
  ) then
    raise exception 'managed-secret locator was exposed through authenticated audit JSON';
  end if;

  denied := false;
  begin
    update public.service_titan_connections
    set display_name = 'Direct browser mutation'
    where id = v_connection_id;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'direct authenticated connection update was not denied';
  end if;

  denied := false;
  begin
    insert into public.service_titan_connection_locations (
      organization_id, connection_id, location_id
    ) values (
      'a0000000-0000-4000-8000-000000000001',
      v_connection_id,
      'a2000000-0000-4000-8000-000000000001'
    );
  exception when insufficient_privilege or unique_violation then
    denied := true;
  end;
  if not denied then
    raise exception 'direct authenticated connection assignment was not denied';
  end if;

  denied := false;
  begin
    perform public.register_service_titan_connection(
      'b0000000-0000-4000-8000-000000000002',
      'cross-tenant-st', 'Cross Tenant', 'integration',
      'gcp-secret://projects/schema/secrets/cross-tenant/versions/latest',
      'b3000000-0000-4000-8000-000000000002'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'cross-tenant connection registration was not denied';
  end if;

  if not public.disable_service_titan_connection(
    'a0000000-0000-4000-8000-000000000001', v_connection_id
  ) then
    raise exception 'atomic connection disable returned false';
  end if;
  select pg_catalog.count(*) into affected_rows
  from public.service_titan_connection_locations assignment
  where assignment.connection_id = v_connection_id and assignment.revoked_at is null;
  if affected_rows <> 0 then
    raise exception 'atomic connection assignment revocation left % active rows', affected_rows;
  end if;

  update public.organizations
  set name = 'Schema Tenant A Updated'
  where id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'authenticated owner same-tenant UPDATE failed';
  end if;

  update public.organizations
  set name = 'Cross Tenant Mutation'
  where id = 'b0000000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'cross-tenant UPDATE was not filtered by RLS';
  end if;

  denied := false;
  begin
    insert into public.locations (
      organization_id, location_key, brand_name, display_name, timezone
    ) values (
      'b0000000-0000-4000-8000-000000000002',
      'cross-tenant-write', 'Tenant B', 'Cross Tenant', 'America/Chicago'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'cross-tenant INSERT was not denied by RLS';
  end if;
end
$rls_behavior$;

reset role;

-- Prove the operator-wide grant is service-role-only, idempotent, and explicit membership based.
set local role service_role;
select pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
select pg_catalog.set_config('request.jwt.claim.sub', '', true);
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $operator_access$
declare
  active_tenant_count integer;
  tenant_count integer;
begin
  select pg_catalog.count(*)::integer into active_tenant_count
  from public.organizations organization
  where organization.status = 'active';
  tenant_count := public.grant_owner_access_to_all_tenants('10000000-0000-4000-8000-000000000001');
  if tenant_count <> active_tenant_count then
    raise exception 'operator-wide owner grant returned %, expected %', tenant_count, active_tenant_count;
  end if;
  if public.grant_owner_access_to_all_tenants('10000000-0000-4000-8000-000000000001') <> active_tenant_count then
    raise exception 'operator-wide owner grant was not idempotent';
  end if;
  if (
    select pg_catalog.count(*)
    from public.organization_memberships membership
    where membership.profile_id = '10000000-0000-4000-8000-000000000001'
      and membership.role = 'owner'
      and membership.status = 'active'
  ) <> active_tenant_count then
    raise exception 'operator-wide grant did not materialize explicit memberships';
  end if;
end
$operator_access$;

-- Prove the Champions Group portfolio is explicit, complete, audited, and RPC-only.
do $portfolio_service_setup$
declare
  brand record;
  active_brand_count integer;
  overview_brand_count integer;
  release_ready boolean;
  release_marker text;
  denied boolean;
begin
  perform public.grant_portfolio_owner_access(
    'c1000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Schema verification portfolio owner'
  );
  for brand in
    select organization.id from public.organizations organization where organization.status = 'active'
  loop
    perform public.attach_brand_to_portfolio(
      'c1000000-0000-4000-8000-000000000001', brand.id, 'Schema verification active brand attachment'
    );
  end loop;

  select count(*)::integer into active_brand_count
  from public.organizations organization where organization.status = 'active';
  if (
    select count(*) from public.portfolio_organizations attachment
    where attachment.portfolio_id = 'c1000000-0000-4000-8000-000000000001' and attachment.status = 'active'
  ) <> active_brand_count then
    raise exception 'portfolio attachment coverage is incomplete';
  end if;
  if not exists (
    select 1 from public.portfolio_audit_events audit
    where audit.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
      and audit.target_profile_id = '10000000-0000-4000-8000-000000000001'
      and audit.event_type = 'portfolio_memberships.insert'
  ) then
    raise exception 'portfolio owner grant was not audited';
  end if;
  perform public.grant_portfolio_owner_access(
    'c1000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004',
    'Schema verification temporary portfolio membership'
  );
  perform public.revoke_portfolio_membership(
    'c1000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004',
    'Schema verification portfolio membership revoke'
  );
  if not exists (
    select 1 from public.portfolio_memberships membership
    where membership.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
      and membership.profile_id = '40000000-0000-4000-8000-000000000004'
      and membership.status = 'revoked'
  ) or not exists (
    select 1 from public.portfolio_audit_events audit
    where audit.portfolio_id = 'c1000000-0000-4000-8000-000000000001'
      and audit.target_profile_id = '40000000-0000-4000-8000-000000000004'
      and audit.event_type = 'portfolio_memberships.update'
      and audit.after_state ->> 'status' = 'revoked'
  ) then
    raise exception 'portfolio membership revoke did not persist an immutable audit event';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'public.portfolios', 'SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.portfolio_memberships', 'SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.portfolio_organizations', 'SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.portfolio_audit_events', 'SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('service_role', 'public.portfolios', 'INSERT,UPDATE,DELETE,TRUNCATE')
    or pg_catalog.has_table_privilege('service_role', 'public.portfolio_memberships', 'INSERT,UPDATE,DELETE,TRUNCATE')
    or pg_catalog.has_table_privilege('service_role', 'public.portfolio_organizations', 'INSERT,UPDATE,DELETE,TRUNCATE')
    or pg_catalog.has_table_privilege('service_role', 'public.portfolio_audit_events', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'portfolio governance tables must be mutation-free outside governed RPCs';
  end if;

  denied := false;
  begin
    update public.portfolio_audit_events set reason = 'mutated audit' where portfolio_id = 'c1000000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'portfolio audit mutation was not denied'; end if;

  denied := false;
  begin
    delete from public.portfolio_organizations
    where portfolio_id = 'c1000000-0000-4000-8000-000000000001'
      and organization_id = 'a0000000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'non-QA portfolio attachment deletion was not denied'; end if;

  select readiness.ready, readiness.release_marker into release_ready, release_marker
  from public.get_release_readiness() readiness;
  if release_ready is distinct from true or release_marker is distinct from '20260818001200_atomic_qa_portfolio_cleanup' then
    raise exception 'portfolio release readiness failed after fixture attachment';
  end if;
end
$portfolio_service_setup$;
reset role;

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
select pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select pg_catalog.set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $portfolio_authenticated$
declare
  active_brand_count integer;
  overview_brand_count integer;
begin
  if public.has_portfolio_access() is distinct from true then raise exception 'portfolio owner access was not resolved'; end if;
  select count(*)::integer into active_brand_count from public.organizations organization where organization.status = 'active';
  select count(*)::integer into overview_brand_count from public.get_portfolio_overview();
  if overview_brand_count <> active_brand_count then
    raise exception 'portfolio overview returned % brands, expected %', overview_brand_count, active_brand_count;
  end if;
  if public.can_access_portfolio_brand('b0000000-0000-4000-8000-000000000002') is distinct from true then
    raise exception 'portfolio owner could not navigate to an explicitly authorized brand';
  end if;
end
$portfolio_authenticated$;

select pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
select pg_catalog.set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $portfolio_unauthorized$
declare
  denied boolean := false;
begin
  if public.has_portfolio_access() is distinct from false then raise exception 'brand-only user gained portfolio access'; end if;
  if public.can_access_portfolio_brand('b0000000-0000-4000-8000-000000000002') is distinct from false then
    raise exception 'brand-only user gained portfolio navigation access';
  end if;
  begin
    perform * from public.get_portfolio_overview();
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'brand-only user could execute the portfolio overview'; end if;
end
$portfolio_unauthorized$;
reset role;

-- anon can execute only the non-secret readiness RPC; this SELECT itself proves execution.
set local role anon;
select * from public.get_release_readiness();
reset role;

-- Human-readable summaries are useful in CI logs after all assertions pass.
select tablename, rowsecurity
from pg_catalog.pg_tables
where schemaname = 'public'
order by tablename;

select tablename, cmd, roles, policyname
from pg_catalog.pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

select relation.relname as table_name,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT') as auth_select,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT') as auth_insert,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE') as auth_update,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE') as auth_delete,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'TRUNCATE') as auth_truncate,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'REFERENCES') as auth_references,
       pg_catalog.has_table_privilege('authenticated', relation.oid, 'TRIGGER') as auth_trigger
from pg_catalog.pg_class relation
join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
order by relation.relname;

rollback;
