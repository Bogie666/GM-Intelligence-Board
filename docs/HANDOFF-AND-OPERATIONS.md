# Handoff and Operations Guide

## Goal

A future portfolio administrator should onboard and maintain a brand without engineering help for routine changes.

## New tenant onboarding checklist

1. Create tenant and operating locations.
2. Assign timezone, fiscal calendar, workdays, logo, and colors.
3. Add ServiceTitan credentials in encrypted server storage.
4. Test token acquisition and required API scopes.
5. Sync business units, employees, job types, statuses, campaigns, membership tiers, and equipment metadata.
6. Map business units to reporting divisions.
7. Map employee roles and sales lead types.
8. Resolve every unmapped status/tier needed by enabled KPIs.
9. Upload monthly budgets and validate totals against finance.
10. Configure KPI targets and warning thresholds.
11. Run a 30-day reconciliation against ServiceTitan reports.
12. Invite users and assign tenant/location roles.
13. Publish the GM layout only after data confidence is acceptable.

### Saved ServiceTitan report onboarding

1. Confirm the tenant connection is ready, assigned to the exact location, and has **Reporting → Reports within the category (Read)** permission.
2. Discover the category and report through Reporting API v2; store immutable category/report IDs, not the mutable display name.
3. Inspect the report description and record `modifiedOn`, typed parameters, accepted/dynamic values, and returned fields.
4. Bind every required parameter. Dynamic business-unit values must map exactly to the governed location and cannot be shared as an ambiguous tenant-wide wildcard.
5. Choose the controlled reduction: sum, average, row count, latest, or ratio. Ratio fields must be distinct numeric fields.
6. Run a bounded sample, validate the returned fields metadata, and calculate the KPI value.
7. Reconcile the result to an approved reference for the same tenant, location, timezone, and period. Record expected/reference values, absolute tolerance, delta, row count, and timestamps.
8. Approve only when expected and observed schema fingerprints match and both sample and reconciliation pass.
9. Publish the KPI only after every scoped location has one ready binding and a fresh materialized observation.
10. Monitor `modifiedOn`, schema fingerprint, cadence freshness, and report execution. Any drift or stale observation must fail closed.

Long-running reports may return `202` from `POST .../data/query`; poll `GET data-queries/{token}` until completion and cancel abandoned queries. Do not run reports from dashboard requests.

### Domo dataset onboarding

1. Create a Domo OAuth client with the `data` scope and store its credentials only in encrypted server configuration.
2. Add approved IDs to `DOMO_ALLOWED_DATASET_IDS`; do not grant the app an open-ended dataset catalog in the public prototype.
3. Record the dataset owner, grain, center/date/account mappings, currency/sign rules, and refresh cadence.
4. Run a metadata/schema check and controlled historical extract.
5. Reconcile source row counts and financial totals before enabling any KPI.
6. Configure stale thresholds and alerts, then materialize snapshots for dashboard reads.

## Routine maintenance

### Daily automated

- incremental provider sync
- freshness monitor
- failed-sync alert
- materialized KPI refresh

### Nightly automated

- rolling source reconciliation
- unmapped-record scan
- snapshot completeness check

### Manual ingestion catch-up

Use only the governed queue worker when an operator needs to drain approved bindings outside the normal scheduler interval:

```bash
npm run data-source:ingest -- --only endpoint --dry-run
npm run data-source:ingest -- --only endpoint
```

The dry run must pass before the materializing run. Both commands retain the due-binding queue, managed-secret resolution, location-timezone period derivation, comparison lineage, source-version lineage, idempotency, and ingestion-run ledger controls. Do not directly query approved bindings, read credential payload columns, call endpoint recipes, or insert `kpi_observations` from an ad hoc force-ingestion script. If a binding is not due, correct the governed scheduler or binding state rather than bypassing it.

### Monthly administrator

- upload/approve budget version
- review mapping changes and new ServiceTitan business units
- inspect source confidence and stale connections
- archive unnecessary custom metrics
- review user access

### Quarterly governance

- certify metric definitions with Finance/Operations
- test credential rotation and recovery
- validate role access
- compare portfolio numbers to source reports
- review forecast error and recalibrate model

## Support workflow

When a KPI looks wrong:

1. Open KPI lineage and record numerator, denominator, period, source freshness, and definition version.
2. Check source sync and unmapped counts.
3. Compare the same window against a defined ServiceTitan report.
4. Determine whether the issue is source, mapping, definition, target, or UI.
5. Correct configuration first. Change governed code only when the definition itself is wrong.
6. Record the change in the audit log and rerun materialization.

## What should remain no-code

- brand/location profile
- timezone and calendar
- business-unit/division mapping
- status, tier, lead-type, and role mapping
- budgets and targets
- thresholds
- card visibility and order
- playbook text
- external connection status
- user/location assignments

## What should require engineering / governed release

- new source connector
- new formula engine capability
- schema migration
- auth/security model change
- new cross-source identity/deduplication logic
- change to a portfolio-standard financial definition

## Demo prototype reset

The following applies only when `APP_MODE=demo`. To reset browser-local test customizations, clear these local-storage keys:

- `gmib.hidden.v1`
- `gmib.orders.v1`
- `gmib.custom-metrics.v1`
- `gmib.custom-kpis.v2` (migration source only)
- `gmib.custom-kpis.v3`
- `gmib.role-templates.v1`
- `gmib.servicetitan-connections.v1`
- `gmib.servicetitan-sources.v2`
- `gmib.target-budget.v1`

Demo mode contains no production data or credentials; its ServiceTitan credential inputs are discarded after masked demo metadata is created. Staging/production mode uses authenticated Supabase persistence and stores only approved opaque secret references. Follow [`PRODUCTION-PILOT-READINESS.md`](PRODUCTION-PILOT-READINESS.md) for guarded tenant onboarding and the current live-KPI release boundary.
