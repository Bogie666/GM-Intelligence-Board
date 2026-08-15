# Production-like Demo Configuration Implementation Plan

> **For Hermes:** Implement this plan task-by-task and verify every persisted configuration on its downstream dashboard consumer.

**Goal:** Make the browser-local GM Intelligence demo faithfully exercise multi-tenant ServiceTitan connection administration plus location/trade/service-line KPI targets and revenue budgets without storing or using production secrets.

**Architecture:** Add versioned local-storage stores whose records mirror the intended Postgres entities. Admin workflows perform real CRUD, validation, draft/publish transitions, effective dating, target precedence, and budget versioning. The dashboard consumes only active published rules and displays target lineage. Demo credential inputs are discarded; only masked identifiers and `secretConfigured` state persist.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, browser localStorage, Playwright QA.

---

### Task 1: Add ServiceTitan connection domain model

**Files:**
- Create: `src/lib/demo-connections.ts`
- Test: `src/lib/demo-connections.test.ts`

**Acceptance:** Seed one isolated profile per demo tenant; validate required fields and unique tenant assignment; support add/edit/archive; never persist raw secrets; recover safely from malformed local storage.

### Task 2: Add target and budget domain model

**Files:**
- Create: `src/lib/targets.ts`
- Test: `src/lib/targets.test.ts`

**Acceptance:** Model effective-dated location/trade/service-line rules, draft/published/archived states, warning and critical thresholds, budget versions, overlap validation, and deterministic target resolution. Only active published records affect dashboard metrics.

### Task 3: Build production-shaped Admin workflows

**Files:**
- Create: `src/components/service-titan-connections.tsx`
- Create: `src/components/targets-and-budgets.tsx`
- Modify: `src/components/admin-console.tsx`
- Modify: `src/app/globals.css`

**Acceptance:** Users can add, edit, validate, archive, and restore multiple tenant connection profiles; add/edit/publish/archive target rules; manage monthly revenue budgets by location and trade; inspect explicit versus inherited scope; and reset seeded demo configuration. Every visible control is wired or explicitly labeled.

### Task 4: Apply configuration to the dashboard

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/components/dashboard.tsx`

**Acceptance:** Dashboard reads published configuration after navigation, applies active location-specific target and budget records, ignores drafts/expired rules, and shows target value, scope, version, and source in the insight drawer.

### Task 5: Document boundaries and operating model

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/HANDOFF-AND-OPERATIONS.md`

**Acceptance:** Documentation distinguishes production-shaped browser persistence from production security, database, RBAC, encryption, worker, and reconciliation requirements.

### Task 6: Verify and release

**Commands:**
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm audit --audit-level=high`
- `rm -rf .next && npm run build`

**Interactive acceptance:** Create a fourth connection profile and verify refresh persistence; edit and publish a location-specific KPI target and verify the selected location dashboard changes while another location does not; edit a revenue budget and verify the revenue target changes; exercise archive/reset; confirm no console/page errors and no raw secret appears in localStorage. Commit, push, verify Vercel, and repeat the downstream browser QA on the deployed URL.
