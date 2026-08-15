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

## Core entities

- `tenants`: one ServiceTitan/account security boundary
- `locations`: operating location, timezone, brand presentation
- `data_connections`: encrypted credentials and provider state
- `business_units`: source units and reporting-division mapping
- `metric_definitions`: formula, format, owner, allowed dimensions
- `metric_overrides`: tenant/location target, threshold, visibility
- `budgets`: monthly location/division targets with upload version
- `layout_templates`: governed card sets by role
- `user_layouts`: permitted personal order/visibility overrides
- `kpi_snapshots`: materialized value, denominator, source timestamp, confidence
- `sync_runs`: provider, watermarks, row counts, errors, reconciliation state
- `audit_events`: actor, tenant, action, before/after, timestamp

Every data-bearing table should include `tenant_id`; location-grain tables should also include `location_id`.

## ServiceTitan ingestion

1. Obtain OAuth token using tenant-isolated credentials.
2. Pull incrementally using modified-on watermarks where supported.
3. Store raw source IDs and normalized facts.
4. Resolve business unit, division, employee role, status, membership tier, and lead type through tenant mappings.
5. Record unmapped row counts instead of silently classifying them.
6. Reconcile recent history nightly because source records can be edited after completion.
7. Materialize KPI snapshots so dashboard loads do not depend on live API latency.

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

This makes numbers explainable and allows the UI to degrade honestly when a source is late or incomplete.

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
