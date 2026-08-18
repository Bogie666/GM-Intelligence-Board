# GM Intelligence Board Production Readiness Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Convert the public browser-local prototype into an invite-only, authenticated, tenant-isolated production pilot that can safely provision organizations, locations, and credential-free ServiceTitan connection metadata without displaying demo data as live.

**Architecture:** Preserve the existing rich prototype under explicit demo mode. In staging/production, require Supabase Auth, resolve one active organization membership server-side under RLS, render a database-backed tenant control plane, and fail closed when configuration or membership is missing. Provider secret values stay outside Postgres; the app persists only opaque secret references. Production deployment and production database changes remain approval-gated.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase Auth/Postgres/RLS, `@supabase/ssr`, Vitest, Vercel.

---

### Task 1: Validate deployment mode and secure HTTP defaults

**Objective:** Make demo/staging/production behavior explicit and fail closed on missing production configuration.

**Files:**
- Create: `src/lib/env.ts`
- Create: `src/lib/env.test.ts`
- Modify: `.env.example`
- Modify: `next.config.ts`
- Modify: `package.json`

**Steps:**
1. Add tests for supported modes and production-required Supabase variables.
2. Implement server-only mode parsing and configuration validation.
3. Add security headers and Node engine pin.
4. Run targeted tests, typecheck, and lint.

### Task 2: Add Supabase SSR authentication

**Objective:** Require a verified Supabase user for non-demo dashboard/admin routes and an owner/admin role for administration.

**Files:**
- Create: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/server.ts`
- Create: `src/lib/auth.ts`
- Create: `src/lib/auth.test.ts`
- Create: `src/proxy.ts`
- Create: `src/app/login/page.tsx`
- Create: `src/components/login-form.tsx`
- Create: `src/app/auth/callback/route.ts`
- Create: `src/app/auth/signout/route.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/admin/page.tsx`
- Modify: `src/app/api/integrations/test/route.ts`

**Steps:**
1. Install `@supabase/ssr`.
2. Add pure role/redirect validation tests.
3. Implement cookie-aware browser/server clients and proxy session refresh.
4. Build password sign-in and sign-out routes; do not expose public signup.
5. Resolve active memberships server-side; reject zero or ambiguous memberships.
6. Gate `/admin` and integration validation to owner/admin.
7. Run targeted tests and static gates.

### Task 3: Add transactional tenant bootstrap and schema readiness

**Objective:** Provide an operator-only, idempotent path to create an Auth user, profile, organization, and first owner membership.

**Files:**
- Create: `supabase/migrations/20260818000100_production_pilot.sql`
- Create: `scripts/bootstrap-tenant.mjs`
- Create: `scripts/remove-qa-tenant.mjs`
- Modify: `supabase/tests/schema_verification.sql`
- Modify: `supabase/README.md`

**Steps:**
1. Add a service-role-only bootstrap RPC with explicit grants/revokes.
2. Add a schema release marker and low-privilege readiness RPC.
3. Add authenticated behavioral/RLS tests for owner access and cross-tenant denial.
4. Add operator bootstrap with input validation, idempotency, and no credential logging.
5. Verify migration in staging and exercise bootstrap with disposable QA data.

### Task 4: Build the database-backed tenant control plane

**Objective:** Allow authenticated owners/admins to manage organization identity, locations, and credential-free ServiceTitan connection metadata.

**Files:**
- Create: `src/lib/tenant-context.ts`
- Create: `src/lib/tenant-context.test.ts`
- Create: `src/app/admin/actions.ts`
- Create: `src/components/production-admin-console.tsx`
- Create: `src/components/sign-out-button.tsx`
- Modify: `src/app/admin/page.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`

**Steps:**
1. Add validation tests for slugs, location keys, timezones, tenant IDs, and opaque secret references.
2. Load organization, locations, connection metadata, and assignments through the authenticated Supabase client/RLS.
3. Implement owner/admin server actions with same-origin checks, validation, tenant binding, and revalidation.
4. Render honest onboarding readiness from persisted rows.
5. Support add/edit/archive location and add/disable connection metadata; never accept raw secret values.
6. In production mode render an explicit no-live-observations state instead of demo metrics.
7. Run component/static/browser QA.

### Task 5: Harden health, observability, and release operations

**Objective:** Provide actionable liveness/readiness and a production deployment runbook.

**Files:**
- Create: `src/app/api/health/live/route.ts`
- Create: `src/app/api/health/ready/route.ts`
- Create: `src/lib/logger.ts`
- Modify: `src/app/api/health/route.ts`
- Create: `docs/DEPLOYMENT.md`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/HANDOFF-AND-OPERATIONS.md`

**Steps:**
1. Keep liveness process-only and make readiness fail closed in staging/production.
2. Verify required release marker and database reachability without returning secret/error details.
3. Add credential-redacted structured logging helpers.
4. Add CI for install, lint, typecheck, tests, build, audit, and secret-pattern checks.
5. Document staging-first migrations, rollback/forward-fix, tenant bootstrap, smoke tests, and explicit production approval.

### Task 6: Close deceptive-control and malformed-state blockers in demo mode

**Objective:** Ensure every visible prototype control is wired, disabled, or clearly explanatory and malformed local state fails closed.

**Files:**
- Modify: `src/components/dashboard.tsx`
- Modify: `src/components/admin-console.tsx`
- Modify: related local-store helpers/tests

**Steps:**
1. Wire CSV export and banner dismissal.
2. Disable or implement Review all, Add location, Review mapping, and location Save.
3. Validate hidden/order storage shapes and catch writes.
4. Ensure persistence failures remain visible and do not report success.
5. Add regression tests where logic can be isolated.

### Task 7: Final verification and independent review

**Objective:** Produce a release candidate backed by fresh gates after the final edit.

**Steps:**
1. Run lint, typecheck, full tests with constrained worker settings, high-severity audit, and production build.
2. Apply and lint migrations against staging; verify remote/local migration parity.
3. Start a fresh local production server on a verified port, probe all static assets, and prove hydration.
4. Exercise login failure/success, role gate, organization/location persistence, connection metadata, reload persistence, cross-tenant denial, sign-out, health endpoints, and browser console.
5. Run independent requirements/security review; fix all material findings and rerun every gate.
6. Inspect diff for credentials, generated artifacts, and accidental files.
7. Prepare a go-live checklist and exact approval-gated deployment commands; do not push, deploy, or modify production without Ryan’s approval.
