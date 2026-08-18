# ServiceTitan KPI Source Bindings Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a production-shaped, tenant-isolated ServiceTitan endpoint/report source-binding workflow to the browser-local GM Intelligence Board demo without exposing credentials or querying ServiceTitan during dashboard loads.

**Architecture:** Keep a global KPI definition separate from tenant-specific ServiceTitan bindings and materialized observations. Model an allowlisted endpoint recipe catalog and an admin-owned saved-report registry with parameters, expected/observed schema, sample execution, reconciliation, approval state, and fail-closed health. The browser-local demo persists only sanitized contracts and illustrative observations; a future server worker will replace the repository and perform OAuth/API/report execution.

**Tech Stack:** Next.js, React, TypeScript, localStorage repository abstraction, Vitest, ESLint.

---

### Task 1: Harden the source and observation domain

**Objective:** Make ServiceTitan report contracts and KPI observations strict, reproducible, tenant-isolated, and fail closed.

**Files:**
- Modify: `src/lib/service-titan-sources.ts`
- Modify: `src/lib/service-titan-sources.test.ts`
- Modify: `src/lib/custom-kpis.ts`
- Modify: `src/lib/custom-kpis.test.ts`

**Steps:**
1. Write failing tests for exact tenant matching, connection/location assignment, archived/mismatched connections, schema drift, stale/future observations, report parameters, sample/reconciliation gates, and secret-bearing/malformed persisted objects.
2. Run the targeted Vitest files and confirm the new tests fail.
3. Add official Reporting API v2 parameter/field metadata, source lifecycle, sample/reconciliation records, parameter bindings, location/business-unit mappings, and materialized observation identity.
4. Replace permissive fallback behavior with strict sanitized parsing. Seed only absent stores; corrupted existing stores become unavailable/empty.
5. Make runtime evaluation require the exact tenant, exact connection, applicable location, active/approved source, current schema, passing reconciliation, and fresh finite observation.
6. Run targeted tests and confirm pass.

### Task 2: Complete the Admin saved-report registry

**Objective:** Represent the production report discovery/inspection workflow honestly in the demo.

**Files:**
- Modify: `src/components/service-titan-source-catalog.tsx`
- Modify: `src/app/globals.css`

**Steps:**
1. Replace comma-delimited field typing with structured report metadata rows and explicit validation.
2. Capture immutable category/report IDs, mutable display metadata, `modifiedOn`, required parameters, output fields, expected/observed schema fingerprints, owner, sample row count/value/time, reconciliation comparison/tolerance/status, and approval state.
3. Label manually entered demo metadata as declared/simulated, not live-discovered.
4. Wire create, cancel, validation, archive, and persistence paths; ensure every actionable control has behavior.
5. Add dependency warnings when archiving a report referenced by a published KPI.

### Task 3: Complete the custom KPI ServiceTitan workflow

**Objective:** Guide users through endpoint recipe or saved-report binding, parameters, field reduction, sample, reconciliation, tenant mapping, and publication.

**Files:**
- Modify: `src/components/kpi-wizard.tsx`
- Modify: `src/lib/custom-kpis.ts`
- Modify: `src/app/globals.css`

**Steps:**
1. Keep the first-class `ServiceTitan KPI` type and method chooser.
2. For each tenant, require an exact ready connection and applicable locations.
3. For reports, render parameter bindings, numeric field mappings, reduction rules, sample/reconciliation evidence, and schema state.
4. For endpoint recipes, show recipe version, controlled capability, date/timezone semantics, and mapping scope.
5. Block publication unless every scoped tenant passes validation and reconciliation; never accept another tenant’s fallback value.
6. Persist source contracts and materialized demo observations separately in intent and labels.

### Task 4: Surface fail-closed source health on the dashboard

**Objective:** Prevent silent disappearance or stale cross-tenant data when a ServiceTitan binding becomes invalid.

**Files:**
- Modify: `src/components/dashboard.tsx`
- Modify: `src/lib/types.ts` only if required
- Modify: `src/app/globals.css`

**Steps:**
1. Load the connection and report registries with the custom KPI definitions.
2. Evaluate ServiceTitan KPIs with exact location and tenant context.
3. Render an explicit unavailable/degraded KPI card or source-health notice with the last valid observation and remediation reason instead of using another tenant’s value or silently dropping the KPI.
4. Keep all dashboard rendering materialized/local; do not add browser or dashboard-time ServiceTitan requests.

### Task 5: Document and verify

**Objective:** Produce a QA-backed local release candidate without modifying production.

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/HANDOFF-AND-OPERATIONS.md`

**Steps:**
1. Document official Reporting API v2 methods, immutable report IDs, mutable schemas, required portal permissions, async `200/202` behavior, polling, and dynamic value sets.
2. Document the demo boundary: browser-local declarations and simulated samples; no live ServiceTitan credentials or requests.
3. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm audit --audit-level=high`, and `git diff --check`.
4. Start the fresh production build on an unused local port, verify static assets/hydration, exercise report registration and KPI publication, refresh persistence, switch tenants/locations, induce schema/source failure, and inspect console/runtime errors.
5. Stop the QA server and verify the health URL no longer responds.
6. Review the final diff. Do not push or deploy without Ryan’s explicit production approval.
