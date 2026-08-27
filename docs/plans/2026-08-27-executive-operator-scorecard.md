# Executive Operator Scorecard Implementation Plan

> **For Hermes:** Use `subagent-driven-development` task-by-task, with specification review before quality review.

**Goal:** Replace the generic Executive KPI grid with an eight-card, tenant-governed operator scorecard and make every non-budget source publishable through Admin → Data Sources.

**Architecture:** The Executive UI becomes a curated view model rather than a filter on `section = executive`. Source health stays separate from performance health. Existing approved actuals are reused; new ServiceTitan endpoint recipes materialize repair, maintenance, club maintenance, sales opportunity, and sold-estimate ticket data. MTD/PY comparison is stored as an explicit governed comparison, never inferred from `prior_value`. Revenue budget rows are loaded from published, effective-dated `kpi_targets`; Ryan supplies the values.

**Tech Stack:** Next.js/TypeScript/Vitest, Supabase PostgreSQL/RLS, ServiceTitan endpoint recipes, Node worker, PGlite schema harness, Vercel.

---

## Governed definitions locked for this release

1. **Revenue MTD vs Budget:** completed-job `total`, completion-date basis, MTD in the location timezone. Budget is a published `kpi_targets` row for `revenue-mtd`, `dimensions.planning_type = budget`; budget pace is the monthly budget × local-calendar elapsed fraction.
2. **Run-Rate Forecast vs Budget:** Revenue MTD divided by elapsed local-calendar fraction × full fiscal month. It is explicitly labeled *Run-Rate Forecast*; it is not a statistical projected close.
3. **Repair Job Volume vs PY:** count of completed jobs with binding-pinned repair job-type IDs.
4. **Maintenance & Club Maintenance Volume vs PY:** completed maintenance jobs with binding-pinned maintenance job-type IDs; club subset requires a non-null `membershipId` on the completed job.
5. **Sales Opportunity Volume vs PY:** distinct non-null `jobId` values among estimate records created in the MTD period, matching the opportunity denominator for `sales-close-rate@2`. Lead-turn is shown only when a separately approved source records a true eligible-repair/maintenance-to-opportunity relationship; it must not be fabricated from unrelated job-type counts.
6. **Sales Close Rate:** existing `sales-close-rate@2`: unique opportunity jobs with ≥1 Sold estimate over binding-pinned `soldThreshold`, divided by unique opportunity jobs with any estimate in the created-period cohort.
7. **Sales Average Ticket:** sold-estimate-record average: Sold estimates with `soldOn` in period, sum `subtotal` / count. It replaces the current completed-job ticket mislabeled as a sales ticket. The Admin recipe description discloses that it is an estimate-record—not canonical-winning-opportunity—contract.
8. **Active Memberships:** current active count plus MTD starts, effective ends (earlier of cancellation/expiration), and net (starts − effective ends).

**Explicit constraints:**
- No Gross Margin, Open Capacity, or Call Booking Rate in Executive.
- `prior_value` is never called PY. MTD/PY requires an explicit same-local-date-last-year comparison contract.
- Missing budget/target = Performance *Not assessed*, not On Plan/Watch/Off Plan.
- Missing/invalid source = Data *Unavailable*, never zero.
- Existing approved bindings are archived and re-approved for semantic version changes; never mutated in place.

---

### Task 1: Add comparison and scorecard-budget transport

**Objective:** Carry explicit comparison semantics and published budget data into the authenticated production dashboard without using demo/localStorage targets.

**Files:**
- Modify: `src/lib/tenant-context.ts`
- Modify: `src/lib/tenant-context.test.ts`

**Steps:**
1. Add `dataHealth`, `observationWindow`, `comparisonBasis`, `comparisonValue`, and comparison period boundaries to the production KPI transport. Preserve `health` as a compatibility alias only where required by existing non-Executive sections.
2. Add a tenant/location/month-scoped production budget transport loaded only from published, effective-dated `kpi_targets` rows whose planning type is budget.
3. Reject mismatched tenant, location, KPI, lifecycle, and fiscal-month rows. Return an empty budget collection when none qualifies.
4. Add mapper tests for valid budgets and all rejection paths.

**Verification:** `npm test -- tenant-context.test.ts`

### Task 2: Create explicit local-calendar MTD/PY observation support

**Objective:** Materialize true same-MTD-prior-year values and period boundaries instead of relying on previous observations.

**Files:**
- Create: `supabase/migrations/20260822000300_executive_scorecard_contracts.sql`
- Modify: `scripts/run-data-source-ingestion.mjs`
- Modify: `scripts/lib/servicetitan-endpoint-ingestion.mjs`
- Modify: `scripts/servicetitan-endpoint-ingestion.node-test.mjs`
- Modify: `supabase/tests/schema_verification.sql`
- Modify: `/workspace/tmp-builds/gm-pglite/verify.mjs`

**Steps:**
1. Add an immutable comparison contract to approved endpoint bindings and to observation lineage. Include it in the canonical fingerprint conditionally so legacy defaults retain byte-identical digests.
2. Add MTD `prior_year_to_date` period derivation using the binding location IANA timezone, same local elapsed time, exclusive endpoint bounds, and an explicit Feb-29 clamp policy.
3. Execute the same approved recipe for current MTD and PY comparison periods; persist comparison value, numerator, denominator, boundaries, and basis with the observation.
4. Add MTD/PY regression coverage for DST, exact local midnight, Feb-29, ratio recomputation, and no-comparison behavior.

**Verification:** `npm run test:servicetitan-worker && node /workspace/tmp-builds/gm-pglite/verify.mjs`

### Task 3: Add endpoint recipe contracts for Executive volume and sales-ticket actuals

**Objective:** Make the missing Executive source contracts visible and bindable in Admin.

**Files:**
- Modify: `scripts/lib/servicetitan-endpoint-ingestion.mjs`
- Modify: `scripts/servicetitan-endpoint-ingestion.node-test.mjs`
- Modify: `src/lib/service-titan-sources.ts`
- Modify: `supabase/migrations/20260822000300_executive_scorecard_contracts.sql`
- Modify: `supabase/tests/schema_verification.sql`
- Modify: `/workspace/tmp-builds/gm-pglite/verify.mjs`

**Recipes:**
- `completed-job-type-count@2`: completed jobs in the bound period; required binding `parameter_values.includedJobTypeIds`; optional `membershipRequired` for club-maintenance subset; fails closed on missing/malformed values.
- `sales-opportunity-count@1`: distinct estimate `jobId` in the created-period cohort; same business-unit filtering semantics as close rate.
- `sold-estimate-average-ticket@1`: Sold estimate records with `soldAfter/soldBefore`; `subtotal` sum / sold-record count; fails closed on zero denominator.

**Catalog definitions:** add `repair-job-volume`, `maintenance-job-volume`, `club-maintenance-job-volume`, `sales-opportunity-volume`, and `sales-avg-ticket` to the original catalog. Retire `avg-ticket` for new Executive use only after the successor has passed governed approval. Add catalog wiring and policy cadence/window values exactly to schema verification and PGlite assertions.

**Verification:** worker unit suite, schema harness, and exact catalog/policy assertions.

### Task 4: Make endpoint-recipe setup operable in Admin Center

**Objective:** Allow an owner/admin to create or configure a draft endpoint binding—including job-type parameters and business-unit scope—without browser-side contract authoring.

**Files:**
- Modify: `src/components/production-admin-settings.tsx`
- Modify: `src/lib/production-admin-settings.ts`
- Modify: `src/app/admin/settings-actions.ts`
- Modify/Add tests: existing admin action/component test location after discovery

**Steps:**
1. Add a draft Endpoint Recipe Binding form to Admin → Data Sources that uses only migration-approved static catalog versions and policy cadences.
2. Expose `parameter_values` and `business_unit_mappings` only for draft/rejected bindings, with credential-key rejection retained server-side.
3. Show the required configuration instructions for job-type count recipes and the exact trusted approval handoff. Do not expose an approval bypass.
4. Keep approved contracts immutable and force the archive → replacement-draft flow.

**Verification:** action authorization/tenant tests, origin checks, malformed parameter validation, recipe selectability, approved-binding immutability.

### Task 5: Build the curated Executive view model and export

**Objective:** Render exactly the approved eight cards with compound facts and independent health signals.

**Files:**
- Modify: `src/lib/production-dashboard.ts`
- Modify: `src/lib/production-dashboard.test.ts`

**Steps:**
1. Add `shapeExecutiveScorecard` with a fixed eight-card registry and strict source compatibility checks (location, window, as-of timestamp, comparison basis).
2. Implement budget pace/run-rate math and explicit performance states: On Plan, Watch, Off Plan, Not assessed.
3. Combine maintenance + club maintenance only when sources are comparable; otherwise expose an unavailable compound metric rather than a partial total.
4. Compose membership card from active/new/effective-end/net source contracts.
5. Add Executive CSV with independent performance/data status, comparison basis, budget lineage, and formula neutralization.

**Verification:** unit tests for all eight-card order, status separation, no-budget behavior, MTD/PY labels, run-rate calendar math, compound-card absence/mismatch, and CSV safety.

### Task 6: Replace Executive rendering while retaining department sections

**Objective:** Make Executive a real operator scorecard without breaking Revenue, Calls, Appointments, Sales, or Membership exploration.

**Files:**
- Modify: `src/components/production-dashboard.tsx`
- Modify: `src/app/globals.css`
- Add: component tests/test setup only if existing framework needs it

**Steps:**
1. Render the fixed Executive scorecard only for the Executive section; retain generic KPI rendering for other sections.
2. Remove Gross Margin, Open Capacity, and Call Booking Rate from the Executive composition.
3. Use native buttons for scorecard card actions; show textual **Performance** and **Data** status badges separately; preserve focus trap/Escape/focus restoration in the insight drawer.
4. Use location-local period/as-of labels; remove UTC wording from Executive.
5. Make the eight-card layout responsive and keep decision-critical support facts visible on mobile.

**Verification:** component tests for card order, excluded metrics, accessible controls, missing-budget copy, membership facts, drawer behavior; `npm run typecheck && npm run lint && APP_MODE=production npm run build`.

### Task 7: DB-first release, Lex setup, reconciliation, and production validation

**Objective:** Publish the code and complete the governed data path for all non-budget cards.

**Files/operations:**
- Apply migration before push.
- Enable successor definitions, generate drafts, apply Lex job-type parameter values from the 2026-08-27 read-only taxonomy capture, scope business units, independently reconcile one completed period, approve each binding, ingest, and verify exact observations.

**Lex initial configuration candidates:**
- Repair / maintenance / sales lead job-type groups must be reviewed against the live tenant taxonomy before approval. The 2026-08-27 discovery confirms job type IDs are stable provider IDs and that `membershipId` is available on jobs; it does not by itself define policy. The binding form will require the controlled IDs and audit note.
- Sales Lead-Turn remains unavailable until a report/source proving the job-level eligible-call → opportunity relationship is approved. The Executive card must state this truthfully; no synthetic rate is shipped.

**Verification:**
1. `npm test`, `npm run test:servicetitan-worker`, `npm run typecheck`, `npm run lint`, `npm run check:operator-scripts`, PGlite, `APP_MODE=production npm run build`.
2. Hosted read-only release/readiness verification and rollback-only governance probes.
3. Independent provider-direct reconciliation for each new binding over a completed local period.
4. Ingestion output confirms materialized observations with matching recipe version/source version/fingerprint.
5. Push SHA, poll Vercel production until SHA match, inspect live authenticated dashboard, and force a fresh deploy only if verified DB observations are not rendered.
