# Tenant-Managed Divisions Implementation Plan

> **For Hermes:** Implement this plan task-by-task with test-driven development and independent review before release.

**Goal:** Replace the fixed ServiceTitan trade enum with tenant-managed divisions and add division creation before business-unit mapping.

**Architecture:** Add an organization-scoped `organization_divisions` aggregate in forward-only migration 017. Business-unit mappings reference stable division UUIDs; the Admin Center manages division lifecycle through narrow tenant-admin RPCs and maps current discovered business units to active divisions. “Not mapped” remains the absence of an active mapping and cannot be created as a division.

**Tech Stack:** PostgreSQL/Supabase RLS and RPCs, Next.js server actions, React 19 action state, TypeScript, Vitest, pglast, hosted rollback verification.

---

### Task 1: Add division validation and readiness contracts

**Files:**
- Modify: `src/lib/tenant-context.ts`
- Modify: `src/lib/tenant-context.test.ts`
- Modify: `src/lib/admin-navigation.ts`
- Modify: `src/lib/admin-navigation.test.ts`

**Steps:**
1. Add failing tests for printable unique division names, reserved “Not Mapped” names, and UUID mapping inputs.
2. Add failing tests proving mapping completion requires exact current-revision coverage of all active business units and at least one active division.
3. Implement the smallest pure validation/readiness helpers.
4. Run focused Vitest tests.

### Task 2: Add forward-only migration 017

**Files:**
- Create: `supabase/migrations/20260819001700_tenant_managed_divisions.sql`
- Modify: `supabase/tests/schema_verification.sql`
- Modify: `src/lib/supabase-server.ts`

**Steps:**
1. Create `organization_divisions` with stable IDs, tenant-qualified uniqueness, status, sort order, timestamps, RLS, read-only browser ACL, and configuration audit coverage.
2. Add narrow create/rename/archive/restore/move RPCs with active owner/admin checks, row locking, reserved-name denial, and mapped-division archive protection.
3. Add `division_id` to mappings, backfill legacy trades per organization, validate the composite FK, replace the active index, and drop the fixed `trade` column/constraint.
4. Replace the mapping RPC to accept `divisionId` and validate same-tenant active divisions.
5. Revoke mappings when a newer discovery completes so stale revisions cannot count as current.
6. Add release marker `20260819001700_tenant_managed_divisions` and update readiness.
7. Extend schema/RLS tests for cross-tenant denial, division lifecycle, mapping payload validation, legacy backfill, and ACLs.
8. Parse and execute the complete migration chain in a disposable PostgreSQL fixture.

### Task 3: Add server actions

**Files:**
- Modify: `src/app/admin/actions.ts`
- Modify: `src/app/admin/actions.test.ts`

**Steps:**
1. Add failing tests for create/rename/archive/restore/move authorization and input validation.
2. Add failing tests proving mapping payloads use `divisionId`, reject one-sided unmapped rows, duplicates, foreign IDs, and legacy `trade` input.
3. Implement actions through narrow RPCs.
4. Run focused tests.

### Task 4: Add division manager and six-step setup UI

**Files:**
- Modify: `src/components/production-admin-console.tsx`
- Modify: `src/app/globals.css`

**Steps:**
1. Load active and archived divisions in the authenticated admin workspace.
2. Render organization-wide “Create your divisions” as step 5 after discovery and before mapping.
3. Add create, rename, archive, restore, move-up, and move-down controls with visible action outcomes.
4. Replace Trade selectors with Division selectors and keep “Not mapped” as a temporary status.
5. Rename the setup flow to six steps and compute mapping completion from exact latest-revision coverage.
6. Ensure all controls are wired, labeled, keyboard-usable, and responsive.

### Task 5: Update downstream copy and operator documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCTION-PILOT-READINESS.md`
- Modify: `supabase/README.md`
- Modify: relevant Admin Center copy/tests

**Steps:**
1. Replace ServiceTitan mapping references to fixed trades with tenant-managed divisions.
2. Keep legacy KPI catalog names unchanged where HVAC/Plumbing/Electrical are metric semantics.
3. Document migration/backfill, archive rules, mapping completeness, and operator verification.

### Task 6: Full verification and release preparation

**Steps:**
1. Run typecheck, all Vitest tests, worker tests, ESLint, diff checks, production build, SQL parse, and secret scan.
2. Execute migration 017 inside a rollback transaction against hosted production; verify marker remains 016 afterward.
3. Run independent UX, security, and database/runtime reviews.
4. Fix every release blocker and rerun the complete gate after the final edit.
5. Commit a clean release candidate; do not apply migration 017, push, or deploy without Ryan’s explicit production approval.
