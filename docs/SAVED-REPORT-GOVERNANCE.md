# Saved-report governance runbook

GM Intelligence treats ServiceTitan saved reports as tenant-owned, versioned data contracts. Registration alone never authorizes ingestion.

## Approval requirements

A source and exact-location KPI binding can be approved only when all of the following are true:

1. The ServiceTitan connection is currently `ready`.
2. The connection remains assigned to the binding's active location.
3. The KPI definition is a published ServiceTitan definition.
4. The report source and binding reference the exact same organization, connection, and ServiceTitan tenant.
5. A completed-period live report sample matches the declared ordered schema.
6. The configured KPI reduction produces a finite value.
7. An active tenant owner/admin supplies an independently sourced reference value.
8. The absolute reconciliation delta is within the supplied non-negative tolerance.

The operator worker writes append-only sample and reconciliation evidence through `record_and_approve_service_titan_saved_report`. The database locks the source and binding, rechecks the tenant contract, records an audit event, and approves atomically. Browser roles cannot call this function.

## Operator command

Run from the application repository with production Supabase and ServiceTitan secret access:

```bash
NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='REDACTED' \
npm run servicetitan:approve-report -- \
  --organization-id ORGANIZATION_UUID \
  --binding-id BINDING_UUID \
  --actor-profile-id ACTIVE_OWNER_OR_ADMIN_PROFILE_UUID \
  --period-start 2026-08-01T00:00:00.000Z \
  --period-end 2026-08-02T00:00:00.000Z \
  --reference-value 12345.67 \
  --tolerance 0.01 \
  --confirm ORGANIZATION_UUID:BINDING_UUID:2026-08-01T00:00:00.000Z
```

The Admin Center displays a binding-specific copy/paste command containing the organization, binding, and authenticated approver IDs. Replace only the period, reference value, tolerance, and confirmation timestamp.

## Outcomes

- **Pass:** report source and KPI binding become approved in one database transaction.
- **Reconciliation fail:** immutable sample/failure evidence and an audit event are recorded; approval remains denied. Use a new reference/tolerance and request identity for any legitimate retry.
- **Schema mismatch, stale connection, revoked assignment, tenant mismatch, or unauthorized approver:** the operation fails before approval.

The command prints only bounded status information. It never logs provider credentials, access tokens, raw provider response bodies, or managed-secret contents.
