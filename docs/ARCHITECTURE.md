# Production Architecture

## Executive decision

Build one configurable portfolio application, not one code fork per brand. Tenant differences belong in configuration and governed mappings.

## Application layers

```text
Browser
  ├─ GM dashboard (read-only KPI views + approved layout customization)
  └─ Admin center (portfolio setup, mappings, targets, users, source health)
        │
Next.js application / API
  ├─ Authentication + role/tenant authorization
  ├─ KPI definition engine
  ├─ Forecast / pace calculations
  ├─ Admin APIs + audit log
  └─ Read API / cached portfolio views
        │
Postgres
  ├─ Tenant configuration
  ├─ ServiceTitan normalized warehouse
  ├─ KPI targets / budgets
  ├─ Domo / external-source facts
  ├─ Materialized KPI snapshots
  └─ Users, roles, layouts, audit events
        │
Scheduled workers / queues
  ├─ ServiceTitan incremental sync (15 minutes)
  ├─ Nightly reconciliation
  ├─ Domo financial / historical dataset sync
  ├─ GA4 / phone / booking-source sync
  └─ KPI materialization + source confidence
```

## Staging database implementation

The isolated Supabase PostgreSQL staging project implements the first production-shaped persistence boundary in [`../supabase/migrations/20260817000100_initial_gm_intelligence_board.sql`](../supabase/migrations/20260817000100_initial_gm_intelligence_board.sql). It contains 16 public tables with RLS enabled, no tenant seed data, and no provider credentials. Authenticated reads require active organization membership; administrative configuration writes require an owner/admin role; worker evidence and observations have no authenticated write policies.

The Next.js health endpoint verifies server-side connectivity when staging Supabase variables are configured. Application configuration remains browser-local for now. Moving the repositories and Auth bootstrap onto these tables is a separate controlled migration, not an automatic fallback or dual-write.

## Core entities

- `organizations`: portfolio/company authorization boundary
- `locations`: operating location, timezone, brand presentation
- `service_titan_connections`: credential-free provider metadata and external `secret_reference`; secrets remain in a managed secret store
- `organization_memberships`: Auth-linked tenant roles
- `service_titan_report_sources` and evidence: governed report contracts and validation history
- `custom_kpi_definitions` and exact-location bindings: versioned KPI contracts
- `business_units`: source units and reporting-division mapping
- `metric_overrides`: effective-dated tenant/location/trade/service-line targets, thresholds, status, owner, and version
- `budgets`: exact-location monthly financial targets with trade, source version, owner, and approval status
- `layout_templates`: governed card sets by role
- `profile_layouts`: permitted personal order/visibility overrides
- `kpi_observations`: append-only materialized values and source identity
- `sync_runs`: provider, watermarks, row counts, errors, reconciliation state
- `audit_events`: actor, tenant, action, before/after, timestamp

Every data-bearing table includes `organization_id`; location-grain tables also include `location_id` with composite tenant/location foreign keys.

## ServiceTitan ingestion

1. Obtain OAuth token using tenant-isolated credentials.
2. Pull incrementally using modified-on watermarks where supported.
3. Store raw source IDs and normalized facts.
4. Resolve business unit, division, employee role, status, membership tier, and lead type through tenant mappings.
5. Record unmapped row counts instead of silently classifying them.
6. Reconcile recent history nightly because source records can be edited after completion.
7. Materialize KPI snapshots so dashboard loads do not depend on live API latency.

### Custom KPI source bindings

Global KPI definitions and tenant/location source bindings are separate contracts. One definition may be reused across tenants, but each location must resolve to exactly one authorized connection and one source-specific binding. A materialized observation is accepted only when its deterministic contract fingerprint still matches the binding that produced it.

The fingerprint includes tenant, location, connection, source method, recipe/report identity, source version/schema, refresh cadence, report parameters, business-unit mapping, row reduction, and selected value fields. This prevents an observation from being replayed across tenants, locations, report mappings, or changed schemas.

**Endpoint method:** production workers may execute only versioned allowlisted recipes. Each recipe declares the required ServiceTitan capability, output kind, lineage, and permitted cadence. Free-form URLs, resource names, code, and browser-side credentials are not accepted.

**Saved-report method:** production registration follows the official Reporting API v2 contract:

- `GET report-categories` lists available categories.
- `GET report-category/{category}/reports` lists reports within a category.
- `GET report-category/{category}/reports/{reportId}` returns mutable description metadata, `modifiedOn`, typed parameters, and output fields. The numeric report ID is the stored identity; name and schema are not treated as immutable.
- `GET dynamic-value-sets/{dynamicSetId}` resolves accepted values for parameters such as business units.
- `POST report-category/{category}/reports/{reportId}/data` runs a synchronous report.
- `POST .../data/query` may return `200` with data or `202` with a token; workers poll `GET data-queries/{token}` and may cancel with `DELETE data-queries/{token}`.

Official reference: [ServiceTitan Reporting API v2 endpoints](https://developer.servicetitan.io/docs/apis/tenant-reporting-v2/endpoints). Report inspection requires the portal permission **Reporting → Reports within the category (Read)** for each intended category.

Report output rows are interpreted using the returned fields metadata, not assumed column positions. A binding cannot be approved until expected and observed schema fingerprints match, the sample produces a finite value, and reconciliation is within tolerance. Report refresh is restricted to 4, 12, or 24 hours in this application. Workers use bounded tenant concurrency, jitter, backoff, and provider response guidance; dashboards read only materialized observations.

### Fail-closed health model

The following states are unavailable—not zero and not a fallback value:

- missing, archived, tenant-mismatched, location-unassigned, or capability-incomplete connection;
- missing/ambiguous tenant-location binding;
- archived/unapproved report or report identity mismatch;
- missing required parameter or business-unit mapping;
- expected/observed schema drift;
- failed/missing sample or reconciliation evidence;
- source-contract fingerprint/version mismatch;
- non-finite, invalid, future, or stale observation.

Only a structurally valid, identity-matched historical observation may be displayed as **last valid** context. It is never counted as the current KPI actual.

## Domo ingestion

1. Authenticate server-side at `https://api.domo.com` using OAuth client credentials and the `data` scope.
2. Restrict detail and export reads to `DOMO_ALLOWED_DATASET_IDS`.
3. Extract approved datasets on a schedule; do not call Domo from dashboard requests.
4. Preserve source dataset ID, extraction timestamp, Domo `dataCurrentAt`, row count, and schema fingerprint.
5. Normalize center, period, account/metric, currency, actual/budget, and source-version fields through governed mappings.
6. Reconcile row counts and financial totals before promoting a snapshot.
7. Mark stale, incomplete, or unmapped snapshots as degraded/unavailable rather than zero.

See [`DOMO-INTEGRATION.md`](DOMO-INTEGRATION.md) for the implemented connector boundary and environment contract.

## Metric contract

Every KPI response should include:

```json
{
  "metricId": "call-booking-rate",
  "value": 70.0,
  "numerator": 1988,
  "denominator": 2840,
  "target": 72.0,
  "status": "watch",
  "period": { "from": "2026-08-01", "to": "2026-08-14" },
  "source": "servicetitan-call-center",
  "freshThrough": "2026-08-14T13:42:00Z",
  "confidence": "high",
  "unmappedRecords": 0,
  "definitionVersion": 3
}
```

This makes numbers explainable and allows the UI to degrade honestly when a source is late or incomplete. Every materialized KPI must also preserve the resolved target or budget record ID so historical dashboards do not silently adopt a later target.

## Target and budget resolution

Metric formulas remain centrally governed; operating targets vary independently. For an effective date, target resolution prefers an exact location over a portfolio fallback, then the most specific trade/service-line scope, then the newest governed version. Draft and archived rules never affect dashboards.

Monthly revenue budgets use an exact location + metric + trade + fiscal month match and never inherit a portfolio fallback. Budget versions remain finance-owned and auditable.

The prototype exercises this contract in browser storage: Admin can draft/publish/archive location-specific rules and budgets, and the dashboard displays the resolved goal and target lineage. Production moves the same IDs and resolution rules to Postgres and materialized KPI snapshots.

## Tenant configuration hierarchy

The resolution order should be:

1. user layout preference (presentation only)
2. role/location override
3. tenant override
4. portfolio default

Metric formulas remain governed. A GM may reorder approved cards but should not change financial definitions.

## Authentication and authorization

Recommended roles:

- Portfolio Admin
- Brand Executive
- General Manager
- Department Leader
- Read-only / TV

Authorization must be enforced server-side on every tenant-scoped query. Credentials are write-only after save and encrypted with a managed key.

## Deployment model

Preferred: one Vercel project + one shared Postgres cluster with tenant isolation and row-level policy enforcement. A separate database per tenant offers stronger physical isolation but increases onboarding, migrations, monitoring, and support burden. Use separate databases only when a contractual requirement outweighs portfolio-operating simplicity.

## Non-negotiable operating controls

- visible source freshness and confidence
- nightly reconciliation
- setup-health screen with unmapped counts
- versioned budgets and metric definitions
- audit log for admin changes
- no dashboard query that directly blocks on ServiceTitan
- feature flags for partially onboarded sources
