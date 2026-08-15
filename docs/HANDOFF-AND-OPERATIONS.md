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

## Prototype reset

To reset browser-local test customizations, clear these local-storage keys:

- `gmib.hidden.v1`
- `gmib.orders.v1`
- `gmib.custom-metrics.v1`

No production data or credentials exist in the prototype.
