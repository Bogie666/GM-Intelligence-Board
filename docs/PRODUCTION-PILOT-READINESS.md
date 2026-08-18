# Production Pilot Readiness — 2026-08-18

## Executive decision

- **Control-plane pilot onboarding:** GO after an approved production deployment.
- **Live KPI dashboard:** CONDITIONAL NO-GO until the implemented saved-report worker completes one real integration reconciliation, one controlled production reconciliation, and an approved scheduler/alerting rollout.
- **Production deployment performed:** No.

The production-mode application is authenticated and tenant-isolated. It persists onboarding configuration, governed source/evidence contracts, and KPI observations. It deliberately shows only matching valid observations with explicit current, stale, or unavailable health; demo values are never substituted.

## Approved pilot scope

The first production release may be used to:

1. Authenticate invited tenant owners and administrators.
2. Create and update tenant locations.
3. Register ServiceTitan tenant metadata using an opaque managed-secret reference.
4. Assign one ServiceTitan connection to an exact tenant location.
5. Run the operator-only OAuth and business-unit validation probe.
6. Review persisted tenant connection/readiness inventory.
7. Disable a connection and atomically revoke its active location assignments.
8. Dry-run an approved saved-report binding through the service-role ingestion worker.

It must not be represented as a production-validated live KPI dashboard until the real-tenant reconciliation gates pass. The worker materializes approved saved-report bindings; report discovery, evidence approval, scheduling, and alerting remain governed operator responsibilities.

## Security and tenancy controls

- Supabase SSR sessions with protected production routes.
- Fail-closed rejection of missing, inactive, or ambiguous organization membership.
- Owner/admin authorization for tenant mutations.
- Tenant-scoped RLS and composite organization/location foreign keys.
- Atomic SQL RPCs for connection registration and disable/revocation.
- Service-role key limited to offline operator/worker scripts.
- Browser code receives no service-role key, ServiceTitan app key, client secret, or OAuth token.
- Production application routes reject raw ServiceTitan credentials.
- Accepted pilot references are limited to resolvers implemented by the operator probe:
  - `gcp-secret://projects/PROJECT/secrets/SECRET/versions/latest`
  - `gcp-secret://projects/PROJECT/secrets/SECRET/versions/NUMBER`
  - `env://UPPERCASE_VARIABLE`
- Missing or cross-origin mutation requests fail closed.
- Security headers include CSP, frame denial, MIME sniffing protection, restrictive permissions policy, and production HSTS.

## Verified release evidence

Executed with Node `22.23.2` unless noted otherwise:

- TypeScript: passed.
- ESLint: passed.
- Vitest: 11 files, 129 tests passed.
- ServiceTitan worker: 10 Node contract/reduction/idempotency/redirect tests passed.
- Operator script syntax and `--help` entry points: passed.
- Next.js 16.3.1 optimized production build: passed.
- npm production dependency audit: 0 vulnerabilities.
- Staging database migration push: passed through `20260818000800` with no pending migrations.
- Staging SQL catalog/RLS/behavior verification: passed; transaction rolled back with no fixtures retained.
- Staging health endpoint: HTTP 200; database configured, reachable, and expected release marker ready.
- Unauthenticated `/`: HTTP 307 to login.
- Authenticated `/`: HTTP 200 with the correct tenant and sign-out control.
- Authenticated live-KPI shell: HTTP 200 with a truthful empty state when no approved bindings exist.
- Authenticated `/admin`: HTTP 200 with production administration controls.
- Authenticated `/login`: HTTP 307 to `/`.
- Integration route without Origin: HTTP 403.
- Integration route with cross-origin Origin: HTTP 403.
- Authenticated same-origin ServiceTitan request: HTTP 409 managed-secret-required; raw credentials not accepted.
- Non-object JSON request: HTTP 400.
- Disposable QA tenant bootstrap, authentication, isolation checks, and guarded teardown: passed; QA rows and Auth user removed.
- Independent bounded security review: GO for control-plane pilot with guardrails; NO-GO for live KPI release.

## Migration order

Apply migrations in timestamp order:

1. `20260817000100_initial_gm_intelligence_board.sql`
2. `20260817000200_security_hardening.sql`
3. `20260818000100_production_pilot.sql`
4. `20260818000200_connection_rpc_fail_closed.sql`
5. `20260818000300_operator_secret_reference_guard.sql`
6. `20260818000400_saved_report_source_pin.sql`
7. `20260818000500_production_release.sql`
8. `20260818000600_acl_fail_closed.sql`
9. `20260818000700_constraint_validator_acl.sql`
10. `20260818000800_audit_secret_redaction.sql`
11. `20260818000900_multi_tenant_operator_access.sql`

Verify migration state before application promotion:

```bash
npx supabase@2.53.6 migration list --db-url "$DIRECT_URL"
npx supabase@2.53.6 db push --db-url "$DIRECT_URL" --dry-run --include-all
```

Run `supabase/tests/schema_verification.sql` with a privileged direct PostgreSQL connection and stop if any assertion fails. The script ends with `ROLLBACK` and must leave no tenant fixtures behind.

## Required production environment

```text
APP_MODE=production
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=publishable/RLS-constrained value
SUPABASE_SERVICE_ROLE_KEY=operator/worker environment only
```

`SUPABASE_SERVICE_ROLE_KEY`, database URLs, ServiceTitan credentials, and Domo credentials must not be configured as `NEXT_PUBLIC_*`. Normal web requests do not require the service-role key.

The application release is compiled to require the exact database marker `20260818000900_multi_tenant_operator_access`; the expected marker is intentionally not environment-configurable.

Private-pilot user creation is enforced at the database boundary: only a service-role-preauthorized email can be created, the authorization expires after five minutes, and it is consumed once. The bootstrap script performs this authorization immediately before `admin.createUser()`. If Supabase Management API access becomes available, also disable provider-level public signup as defense in depth.

Pin the deployment runtime to Node 22. The package declares `22.x`, and `.nvmrc` contains `22`.

## Tenant onboarding procedure

### 1. Bootstrap the owner

Use a unique password supplied only through the environment:

```bash
export BOOTSTRAP_USER_PASSWORD='generated-one-time-password'
node scripts/bootstrap-tenant.mjs \
  --email owner@example.com \
  --display-name 'Pilot Owner' \
  --organization-slug pilot-company \
  --organization-name 'Pilot Company' \
  --confirm pilot-company
```

Record the returned profile, organization, and membership IDs in the approved operator ledger. Do not record the password in the ledger.

### 2. Configure the tenant

1. Owner signs in.
2. Add the exact operating location and timezone.
3. Store the ServiceTitan credential JSON in Google Secret Manager or the approved operator environment. The JSON must contain exactly `clientId`, `clientSecret`, and `appKey`.
4. In tenant administration, register only the opaque reference and assign the exact location.

### 3. Validate the connection

```bash
node scripts/validate-servicetitan-connection.mjs \
  --organization-id ORGANIZATION_UUID \
  --connection-id CONNECTION_UUID \
  --confirm ORGANIZATION_UUID:CONNECTION_UUID
```

The probe obtains OAuth in memory, performs one read-only business-unit request, stores safe capability/status metadata, and never prints the credential or token.

### 4. Dry-run and materialize an approved saved report

After the saved report, exact location binding, sample evidence, and reconciliation evidence are approved:

```bash
node scripts/ingest-servicetitan-report.mjs \
  --organization-id ORGANIZATION_UUID \
  --binding-id BINDING_UUID \
  --period-start 2026-08-17T00:00:00.000Z \
  --period-end 2026-08-18T00:00:00.000Z \
  --confirm ORGANIZATION_UUID:BINDING_UUID:2026-08-17T00:00:00.000Z \
  --dry-run
```

Remove `--dry-run` only after the reduced value reconciles to the approved reference. The worker verifies the exact tenant, location assignment, connection, source fingerprint, ordered report fields, evidence, and period; it suppresses duplicate observations with a period-bound idempotency key.

### 5. Pilot acceptance

- Tenant owner can see only their organization.
- Admin can see and mutate only their organization and locations.
- Connection is `ready` and has a validation timestamp.
- No credential material appears in browser HTML, network responses, logs, or audit JSON.
- Health endpoint remains 200.

## Rollback and stop conditions

Stop onboarding immediately if:

- health returns 503;
- schema release readiness is false;
- tenant membership is ambiguous;
- cross-tenant rows are visible;
- an opaque reference cannot be resolved by the operator probe;
- ServiceTitan OAuth or the read-only capability probe fails;
- credential-like data appears in logs, responses, or persisted JSON.
- the direct Auth signup API accepts an email that was not preauthorized by the service-role bootstrap.

Application rollback: promote the last known-good deployment. Do not reverse database migrations destructively. Use a forward correction migration.

Connection rollback: disable the affected connection. The RPC revokes active location assignments atomically.

Disposable QA tenant rollback may use `scripts/remove-qa-tenant.mjs`; it refuses non-`qa-*`, shared, configured, or mismatched tenants.

## Remaining live KPI release gates

Implemented and QA-backed in code: tenant-isolated saved-report execution, exact source/schema checks, controlled reductions, idempotent `kpi_observations`, bounded retries, and production UI reads with current/stale/unavailable states.

Release still requires:

1. An approved real saved report and exact business-unit/location mapping.
2. Passing sample and reconciliation evidence for the current source fingerprint.
3. One ServiceTitan integration-environment end-to-end reconciliation.
4. One controlled production-tenant reconciliation.
5. An approved scheduler with freshness alerts, retry limits, and a kill switch.
6. Verification that the Reporting API scope and rate limits support the selected cadence.

Until all six pass, the go-live claim remains **secure tenant onboarding, connection validation, and worker dry-run**, not production-validated live GM intelligence.
