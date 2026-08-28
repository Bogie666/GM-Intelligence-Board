# Portfolio-safe Domo Month/Year Period Contract Implementation Plan

> **For Hermes:** Execute task-by-task with TDD and independent review before release.

**Goal:** Allow each brand organization/location binding to ingest a compact Domo monthly source whose period is stored in separate Month and Year columns, without any Lex-specific code.

**Architecture:** Extend each organization-scoped `domo_dataset_sources` contract with an explicit period mode and month/year columns. Keep brand/location selection in the existing fingerprinted `filter_column` + `filter_value`; each brand declares its own mapped value and binds that source only inside its RLS tenant. Preserve legacy fingerprints by appending new fingerprint fields only for `month_year` contracts.

**Tech Stack:** PostgreSQL/Supabase RLS, Node.js/Decimal.js worker, Next.js/TypeScript admin, Vitest/Node test/PGlite.

---

### Task 1: Add failing worker tests

**Files:**
- Modify: `scripts/domo-dataset.node-test.mjs`

1. Add successful Lex-style Month=`Aug`, Year=`2026`, location-filtered sum coverage.
2. Add multi-brand isolation coverage proving two contracts over the same export select different mapped location values.
3. Add failures for unknown month, malformed year, absent timezone, non-calendar-aligned start, missing columns, and wrong expected row count.
4. Run `node --test scripts/domo-dataset.node-test.mjs`; expect failures before implementation.

### Task 2: Implement the worker contract

**Files:**
- Modify: `scripts/lib/domo-dataset.mjs`
- Modify: `scripts/run-data-source-ingestion.mjs`
- Modify: `scripts/approve-data-source-binding.mjs`

1. Validate `periodMode` as `none|date|month_year`.
2. Require exact mutually exclusive date versus month/year fields.
3. Parse bounded English month names/numbers and four-digit years.
4. Resolve month keys in the binding location timezone and require a calendar-aligned month/year start.
5. Apply the independent location filter before period parsing.
6. Enforce optional `expectedPeriodRows` after both filters.
7. Pass all contract fields and `location_timezone` through approval and scheduled ingestion.
8. Rerun focused Node tests; expect pass.

### Task 3: Add the additive database migration

**Files:**
- Create: `supabase/migrations/20260828000200_domo_month_year_period.sql`
- Modify: `supabase/tests/schema_verification.sql`
- Modify: `/workspace/tmp-builds/gm-pglite/verify.mjs`

1. Add `period_mode`, `month_column`, `year_column`, and `expected_period_rows`.
2. Backfill `period_mode` to `date` when legacy `date_column` exists, otherwise `none`.
3. Add exact shape constraints.
4. Redefine fingerprinting so legacy source digests remain byte-identical and new fields are fingerprinted for new contracts.
5. Replace the old `create_domo_dataset_source` RPC signature with the complete new signature, preserving tenant-admin checks and audit behavior.
6. Add schema and PGlite checks for migration, fingerprints, tenant-scoped source declarations, rollback, and zero residue.
7. Run PGlite from zero and rollback; expect all migrations and schema verification to pass.

### Task 4: Extend admin validation, loading, and forms

**Files:**
- Modify: `src/lib/domo-admin.ts`
- Modify: `src/lib/domo-admin.test.ts`
- Modify: `src/app/admin/settings-actions.ts`
- Modify: `src/app/admin/settings-actions-data-sources.test.ts`
- Modify: `src/lib/data-source-workers.ts`
- Modify: `src/lib/data-source-workers.test.ts`
- Modify: `src/lib/production-admin-settings.ts`
- Modify: `src/components/production-additional-data-sources.tsx`

1. Add strict TypeScript contract fields and validation.
2. Send the full contract through the tenant-derived creation RPC.
3. Inspect all configured columns.
4. Add admin period-mode controls and explain that the mapped filter value is per brand/location.
5. Display the declared period and row-cardinality contract on source records.
6. Run focused Vitest, typecheck, and ESLint; expect pass.

### Task 5: Full release gates

1. Run full app, worker, typecheck, lint, operator scripts, PGlite, and production build.
2. Run a read-only live Domo proof for `Master Location=Lex`, Month=`Aug`, Year=`2026`, expected row count `1`; expect `$2,486,921.00`.
3. Run independent security/spec review; resolve all blockers.

### Task 6: DB-first production release

1. Verify GitHub push and Vercel credentials non-mutating.
2. Record current production deployment and live database marker.
3. Commit the complete reviewed release locally with the Bogie666 Vercel-safe author.
4. Apply the new migrations atomically to production before pushing.
5. Run hosted schema verification and smallest rollback-only behavior probes.
6. Push the exact commit to `main`.
7. Poll Vercel until the exact SHA is READY.
8. Verify the stable alias `/api/health` reports the exact SHA and healthy schema.
9. Perform production browser smoke QA without creating/approving a source unless separately required.
