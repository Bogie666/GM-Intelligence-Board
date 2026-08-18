# GM Intelligence Board

A configurable, multi-tenant KPI command center for Champions Group general managers.

This repository contains two explicit modes: a polished browser-local **demo** with illustrative data and an authenticated, database-backed **staging/production application** for governed tenant onboarding and live KPI observations. A fail-closed saved-report ingestion worker is implemented; live tenant release still requires a real ServiceTitan reconciliation and an approved scheduler.

## Live prototype behavior

- Portfolio / location switcher with isolated brand styling
- Six GM views: Executive, Revenue, Calls & Digital, Appointments, Sales, Membership
- Semantic KPI status, goals, trends, source lineage, and actionable playbooks
- Drag/reorder and hide/restore cards per location and tab
- Browser-local custom KPI builder in Admin → KPI Library
- Admin role-template editor with per-tab KPI visibility, default ordering, renaming, reset, and save behavior
- Admin setup checklist, browser-local multi-tenant ServiceTitan connection profiles, source matrix, and role model
- Governed ServiceTitan KPI source builder with versioned endpoint recipes, tenant/location bindings, and saved Reporting API v2 report declarations
- Fail-closed ServiceTitan source health on published custom KPI cards; stale, drifted, ambiguous, or unauthorized bindings never become current KPI values
- Effective-dated location/trade/service-line KPI targets with draft, publish, archive, and target lineage
- Versioned exact-location monthly revenue budgets that drive dashboard goals in the same browser
- Server-only Domo OAuth/DataSet API scaffold with dataset allowlisting and CSV export support
- Domo source configuration in Admin and the governed KPI builder
- `/api/health` plus ServiceTitan and Domo integration-validation modes
- Responsive desktop, tablet, and mobile layouts

> All displayed values are labeled demo data. Do not enter production credentials in this build.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Use Node 22. Copy `.env.example` to `.env.local` for local staging or demo work. `SUPABASE_SERVICE_ROLE_KEY`, database URLs, ServiceTitan credentials, and all Domo credentials are server/operator-only. Only the Supabase URL and anon/publishable key may use `NEXT_PUBLIC_*`.

## Staging database foundation

An isolated Supabase PostgreSQL staging project now hosts the initial tenant-safe schema. The version-controlled artifacts are under [`supabase/`](supabase/):

- 16 RLS-enabled public tables for organizations, locations, memberships, ServiceTitan source governance, KPI definitions/bindings, observations, targets, layouts, and audit events
- exact organization/location foreign keys and uniqueness constraints
- immutable ServiceTitan/report identity and append-only evidence, observation, and audit controls
- SHA-256 canonical source fingerprints generated inside PostgreSQL
- no tenant seed data, production credentials, ServiceTitan tokens, or Auth users

The server health endpoint verifies database reachability and the expected schema release without using the service-role key. `APP_MODE=staging` or `production` enables Supabase SSR authentication, fail-closed tenant resolution, and database-backed tenant administration. `APP_MODE=demo` remains intentionally browser-local.

See [`supabase/README.md`](supabase/README.md) for migration, RLS, bootstrap, and verification procedures.

## Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Prototype persistence

The test build stores these non-sensitive demo configurations in browser `localStorage`:

- card order
- hidden cards
- custom demo KPIs
- role-template KPI visibility and default ordering (`gmib.role-templates.v1`)
- tenant/location ServiceTitan connection metadata with masked identifiers only (`gmib.servicetitan-connections.v1`)
- declared/simulated ServiceTitan report contracts, schema fingerprints, and evidence (`gmib.servicetitan-sources.v2`)
- governed custom KPI definitions and browser-local materialized demo observations (`gmib.custom-kpis.v3`)
- effective-dated KPI target rules and monthly revenue budget versions (`gmib.target-budget.v1`)

Published target and budget changes become the applicable dashboard goals immediately in the same browser. Saved changes to the **GM daily view** become the dashboard default. Individual GM drag/hide preferences remain a separate override layer.

Demo mode does **not** persist raw credentials, users, or live API response data. Staging/production mode persists users and governed control-plane metadata in Supabase, but never accepts raw ServiceTitan credentials through the web application. Only an opaque Google Secret Manager or approved environment reference is stored. The operator worker ingests only approved, evidenced saved-report bindings and writes idempotent observations.

## ServiceTitan source-binding boundary

The prototype supports two governed source methods:

1. **Endpoint recipes:** an application allowlist with immutable recipe IDs, versions, required connection capabilities, output types, and allowed refresh intervals.
2. **Saved reports:** tenant/connection-bound declarations using immutable ServiceTitan category/report IDs, mutable report metadata, typed parameters, expected/observed schema fingerprints, controlled reductions, sample evidence, and reconciliation evidence.

Each materialized demo observation is bound to the complete contract: tenant, location, connection, source identity/version, cadence, report parameters, business-unit mapping, reduction, and selected fields. Runtime evaluation requires one exact ready binding and a fresh matching observation. Missing access, schema drift, failed evidence, stale data, future timestamps, or ambiguous mappings render an explicit **Unavailable** source-health card; the dashboard never substitutes another tenant/location or treats unavailable as zero.

No browser or dashboard request calls ServiceTitan. `scripts/ingest-servicetitan-report.mjs` runs approved saved reports in a service-role worker, validates exact ordered field metadata, performs controlled reductions, and writes idempotent materialized observations. Report discovery and evidence approval remain governed onboarding steps.

Worker quality gates and entry point:

```bash
npm run test:servicetitan-worker
npm run servicetitan:ingest-report -- --help
```

## Production architecture

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/KPI-DATA-SOURCE-MATRIX.md`](docs/KPI-DATA-SOURCE-MATRIX.md)
- [`docs/HANDOFF-AND-OPERATIONS.md`](docs/HANDOFF-AND-OPERATIONS.md)
- [`docs/DOMO-INTEGRATION.md`](docs/DOMO-INTEGRATION.md)

## Recommended production phases

1. **Foundation:** PostgreSQL, RLS, SSR Auth/RBAC, transactional tenant bootstrap, production-mode persistence, and connection validation are established and verified in staging.
2. **ServiceTitan onboarding:** validate the saved-report worker against the integration environment, complete exact business-unit mapping and source evidence, reconcile the first observation, then attach an approved scheduler.
3. **Finance controls:** governed Domo/CSV ingestion, budgets, targets, workday calendars, forecast definitions.
4. **External sources:** GA4, phone/CCaaS, web booking/chat events, attribution deduplication.
5. **Portfolio operations:** cross-brand rollups, alerts, exports, setup health, source confidence, support runbooks.

## Security boundary

Every ServiceTitan tenant must have:

- isolated encrypted credentials
- tenant-scoped warehouse rows and database access policies
- role-scoped access to assigned brands/locations
- no credentials returned to browser clients
- audit events for connection, mapping, budget, target, and user changes

Every Domo connection must remain server-only, restrict reads to approved dataset IDs, and materialize reconciled snapshots rather than making dashboard loads depend on the live Domo API.

## Repository status

**Control-plane pilot:** release candidate, subject to approved production deployment and the guardrails in [`docs/PRODUCTION-PILOT-READINESS.md`](docs/PRODUCTION-PILOT-READINESS.md).

**Live KPI dashboard:** release candidate code path, not yet approved for production data. Production mode now renders only valid current/stale/unavailable materialized observations. The remaining gates are one real integration-environment reconciliation, one controlled production-tenant reconciliation, and an approved scheduler/alerting configuration.
