# GM Intelligence Board Supabase schema

This directory contains version-controlled schema artifacts for the isolated GM Intelligence private-pilot Supabase project. It does not contain a remote project reference, credentials, production data, or demo seed data. Production changes are forward-only migrations and are verified by the rollback-only schema suite.

## Artifacts

- `config.toml` — local Supabase CLI configuration; seeds are disabled.
- `migrations/20260817000100_initial_gm_intelligence_board.sql` — the initial tenant-safe schema already applied to isolated staging.
- `migrations/20260817000200_security_hardening.sql` — forward-only ACL, membership governance, approval provenance, secret-boundary, and published-version hardening.
- `migrations/20260818000100_production_pilot.sql` — forward-only service-role tenant bootstrap, release readiness, guarded QA cleanup, and governor-trigger execution hardening.
- `migrations/20260818000200_connection_rpc_fail_closed.sql` — atomic, fail-closed connection registration and disable/revocation RPCs.
- `migrations/20260818000300_operator_secret_reference_guard.sql` — restricts connection references to schemes supported by the operator resolver.
- `migrations/20260818000400_saved_report_source_pin.sql` — pins KPI bindings to immutable approved saved-report fingerprints.
- `migrations/20260818000500_production_release.sql` — final release marker, RPC-only connection administration, managed-secret-locator confidentiality, role-aware KPI visibility, and the authoritative current-observation gate.
- `migrations/20260818000600_acl_fail_closed.sql` — explicit fail-closed anonymous/authenticated function ACL allowlists and final release marker.
- `migrations/20260818000700_constraint_validator_acl.sql` — restores only the pure CHECK-constraint validators required by authenticated configuration writes.
- `migrations/20260818000800_audit_secret_redaction.sql` — removes managed-secret locators from historical and future connection audit snapshots.
- `migrations/20260818000900_multi_tenant_operator_access.sql` — service-role-only atomic owner-membership grant for explicitly approved multi-tenant operators.
- `migrations/20260818001000_champions_group_portfolio.sql` — explicit Champions Group portfolio, brand attachments, portfolio memberships, audited lifecycle RPCs, and fail-closed portfolio overview.
- `migrations/20260818001100_portfolio_audit_trigger_fix.sql` — table-safe portfolio audit identity comparisons.
- `migrations/20260818001200_atomic_qa_portfolio_cleanup.sql` — QA-only terminal portfolio-membership cleanup with immutable historical subject IDs.
- `migrations/20260818001300_admin_credential_vault.sql` — authenticated owner/admin ServiceTitan credential encryption in Supabase Vault, governed service-role resolution, U.S.-timezone enforcement, rotation, and retirement.
- `migrations/20260818001400_configuration_revision_race_guard.sql` — compare-and-set credential revisions and serialized observation writes that fail closed across concurrent credential rotation; current release marker.
- `tests/schema_verification.sql` — catalog assertions plus rollback-only service-role/bootstrap and authenticated cross-tenant RLS behavior checks.

The migration models organizations, locations, Auth-linked profiles, memberships/RBAC, credential-free ServiceTitan metadata and exact location assignments, governed saved-report sources, source-fingerprint evidence, versioned custom KPI definitions and exact location bindings, append-only observations, targets, layouts, and append-only audit events.

## Security and credential boundary

`service_titan_connections.secret_reference` is an opaque identifier for a managed secret outside Postgres. It is **not** a secret value. It must use one of the recognized reference schemes: `gcp-secret://...`, `supabase-vault://...`, or `env://...`. Never put OAuth access/refresh tokens, client secrets, ServiceTitan app keys, API keys, authorization headers, or credential payloads in this schema, JSONB, audit events, migrations, fixtures, logs, or browser state. Credential-like JSON keys (including `token`, `secret`, and `secret_reference`) are rejected recursively; a narrow audit-only exception preserves the validated top-level connection reference identifier, not a resolved secret.

A server-only worker uses the Supabase service role and resolves `secret_reference` through the deployment secret manager. The service role bypasses RLS, so it must never be exposed to Next.js client code, browser state, logs, or an untrusted runtime. Authenticated receives only ordinary table DML ACLs—never `TRUNCATE`, `REFERENCES`, or `TRIGGER`—and authenticated browser sessions have no write policies or grants for report evidence, binding evidence, observations, or audit events. `anon` has no public-table ACLs or policies.

Approval and membership authorization are also enforced by database triggers rather than relying on UI behavior. Authenticated approval/publication transitions are attributed by the database to `auth.uid()` and the database clock and require an active same-organization owner/admin. A trusted service-role approval must supply a valid active same-organization owner/admin attribution; invalid or absent attribution fails closed. Evidence recorders, audit actors, KPI owners, and approvers are tenant-qualified through membership foreign keys.

## Release readiness

Migration `20260818001400` records the non-secret marker `20260818001400_configuration_revision_race_guard` in an RLS-protected table with no `anon` or `authenticated` table privileges. The read-only `get_release_readiness()` RPC exposes only `ready` and `release_marker` and is executable by low-privilege API roles. Readiness also requires the active Champions Group portfolio, at least one active portfolio owner, and attachment coverage for every active brand. The application is compiled to require that exact marker; a successful HTTP connection alone is not schema readiness.

## Auth and first-organization bootstrap

Supabase Auth owns `auth.users`; the migration does not create Auth users or an automatic organization-on-signup trigger. In staging, a trusted server-side bootstrap transaction should:

1. create/sign up the Auth user through Supabase Auth;
2. insert `public.profiles(id)` with the exact `auth.users.id`;
3. insert the first `public.organizations` row;
4. insert an active `public.organization_memberships` row with role `owner` and a non-null `joined_at`.

`bootstrap_tenant_owner(...)` performs steps 2–4 in one database transaction for an existing, email-matched Auth user. It is idempotent for the exact same user/profile/organization/owner state, serializes concurrent retries, and rejects slug reuse, profile drift, or an owner attached to another organization. Its function ACL and runtime claim check both require `service_role`; `anon` and `authenticated` cannot execute it.

Use the operator script from the repository root. Keep secrets in the process environment, never command arguments:

```bash
BOOTSTRAP_USER_PASSWORD='use-an-operator-supplied-random-password' \
NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='operator-local-service-role-key' \
GM_PLATFORM_OWNER_PROFILE_ID='approved-platform-owner-profile-uuid' \
GM_DEFAULT_PORTFOLIO_ID='c1000000-0000-4000-8000-000000000001' \
npx --yes --package=node@22.23.2 --call "node scripts/bootstrap-tenant.mjs \
  --email owner@example.com \
  --display-name 'Pilot Owner' \
  --organization-slug pilot-company \
  --organization-name 'Pilot Company' \
  --confirm pilot-company"
```

The script creates the Auth user with confirmed email, calls the transactional RPC, and removes a newly created Auth user if the database transaction fails. Retrying the exact command is safe. It does not reset the password of an existing Auth user and does not print email, password, service key, or API error bodies. Preserve the returned user/organization IDs in the operator record; do not commit them.

Browser clients still cannot create organizations, create profiles, or bootstrap owner membership. Subsequent configuration writes are RLS-limited to active organization owners/admins. Membership triggers additionally ensure that only owners can grant or manage owner/admin roles, admins cannot promote themselves or modify/revoke/delete owners, and every organization retains at least one active owner. A null `auth.uid()` is accepted only as the trusted service-role bootstrap/migration boundary; it does not bypass tenant identity or last-owner invariants. Do not add staging identities or tenant data to a seed migration.

### Disposable QA removal

Removal is deliberately not a general tenant-deletion feature. `remove_empty_qa_tenant(...)` refuses any slug outside `qa-*`, any tenant with more than the original active owner, a shared owner, or any configuration/fact rows. The script additionally requires exact email/user ID/organization ID/slug agreement and an explicit composite confirmation:

```bash
NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='operator-local-service-role-key' \
GM_PLATFORM_OWNER_PROFILE_ID='approved-platform-owner-profile-uuid' \
GM_DEFAULT_PORTFOLIO_ID='c1000000-0000-4000-8000-000000000001' \
npx --yes --package=node@22.23.2 --call "node scripts/remove-qa-tenant.mjs \
  --email qa-owner@example.com \
  --organization-slug qa-disposable-pilot \
  --organization-id 00000000-0000-4000-8000-000000000000 \
  --user-id 00000000-0000-4000-8000-000000000000 \
  --confirm 'qa-disposable-pilot:<organization-id>:<user-id>'"
```

Portfolio preparation and empty-QA database teardown run inside one atomic RPC; any legacy teardown refusal rolls the portfolio changes back. Database teardown commits before Auth deletion because profile/membership foreign keys prevent deleting Auth first. If Auth deletion fails, rerun the exact command: it resumes only when the expected organization, profile, and memberships are already absent. Never use the QA path for pilot or production tenant offboarding.

## Local migration workflow

Prerequisites: Supabase CLI and a Docker-compatible local runtime.

```bash
# From the repository root. Destructive only to the local Supabase database.
supabase start
supabase db reset

# Run catalog/security plus rollback-only RLS behavior assertions locally.
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/tests/schema_verification.sql

# Optional CLI/database checks.
supabase db lint --local
supabase migration list --local
```

Stop the disposable stack with `supabase stop`. `db reset` is intentionally destructive and must not be pointed at a shared database.

## Repeatable staging application procedure

Before applying to staging:

1. review the migration and `git diff --check` in a clean change set;
2. create a database backup/PITR checkpoint as applicable;
3. link the CLI using an operator-local project ref (never commit `.supabase/` or credentials);
4. run a dry-run/diff and review it;
5. apply migrations only through the approved staging release workflow;
6. run `tests/schema_verification.sql` against staging with a privileged migration connection (only when disposable fixture creation inside its rolled-back transaction is approved);
7. bootstrap a disposable `qa-*` owner with the operator script, verify owner access and cross-organization denial, then remove it with the exact IDs and guarded QA script.

The project reference and credentials remain operator-local and ignored by Git. Production promotion requires an exact reviewed Git SHA, forward-only migration dry run, release-readiness proof, schema/RLS rollback suite, exact-SHA Vercel verification, and authenticated disposable-tenant cleanup.

## Design assumptions

- PostgreSQL 17, matching the staging project and `config.toml`.
- Supabase provides `auth.users`, roles `anon`, `authenticated`, and `service_role`, and the `extensions` convention used by `pgcrypto`.
- Every public table has RLS enabled. Active membership gates reads; configuration writes require `owner` or `admin`; audit reads are also owner/admin-only; anon has no table grants or policies.
- Canonical source fingerprints are database-owned SHA-256 values over canonical JSONB contracts. Evidence inserts and observations are forced to the current fingerprint by triggers, so clients cannot attest to another tenant/location/source contract.
- Changing any fingerprint-bearing saved-report or KPI-binding contract automatically downgrades it to draft, clears approval provenance, and requires fresh passing sample and reconciliation evidence for the newly computed fingerprint before approval.
- Saved-report connection/tenant/category/report identity and KPI organization/key/version identity are immutable. Changed identity requires a new row/version.
- Published KPI definitions, KPI targets, and layout templates cannot return to draft or mutate governed fields in place. Published rows may only be archived; published/archived rows cannot be deleted, and republication requires a new version row.
- Evidence, observations, and audit events are append-only. Corrections are new facts, never in-place edits.
- There is intentionally no seed data: even illustrative tenants would create misleading staging authorization and source records.
