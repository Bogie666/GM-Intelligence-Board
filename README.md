# GM Intelligence Board

A configurable, multi-tenant KPI command center for Champions Group general managers.

This repository currently contains a polished **test build** with illustrative data. It demonstrates the target dashboard, administration workflow, tenant switcher, KPI source labeling, custom metrics, card hiding, and drag/reorder behavior without requiring production credentials.

## Live prototype behavior

- Portfolio / location switcher with isolated brand styling
- Six GM views: Executive, Revenue, Calls & Digital, Appointments, Sales, Membership
- Semantic KPI status, goals, trends, source lineage, and actionable playbooks
- Drag/reorder and hide/restore cards per location and tab
- Browser-local custom KPI builder in Admin → KPI Library
- Admin role-template editor with per-tab KPI visibility, default ordering, renaming, reset, and save behavior
- Admin setup checklist, tenant configuration, ServiceTitan field validation, source matrix, and role model
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

Copy `.env.example` to `.env.local` only when configuring the server-side Domo connector. Never use `NEXT_PUBLIC_*` for Domo credentials.

## Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Prototype persistence

The test build stores only these non-sensitive presentation settings in browser `localStorage`:

- card order
- hidden cards
- custom demo KPIs
- role-template KPI visibility and default ordering (`gmib.role-templates.v1`)

Saved changes to the **GM daily view** become the dashboard default immediately in the same browser. Individual GM drag/hide preferences remain a separate override layer.

It does **not** persist credentials, tenant mappings, budgets, users, or API data. Production must use Postgres and encrypted server-side secret storage.

## Production architecture

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/KPI-DATA-SOURCE-MATRIX.md`](docs/KPI-DATA-SOURCE-MATRIX.md)
- [`docs/HANDOFF-AND-OPERATIONS.md`](docs/HANDOFF-AND-OPERATIONS.md)
- [`docs/DOMO-INTEGRATION.md`](docs/DOMO-INTEGRATION.md)

## Recommended production phases

1. **Foundation:** Postgres schema, auth/RBAC, encrypted credentials, audit log.
2. **ServiceTitan onboarding:** credentials, business-unit mapping, status mapping, warehouse sync, reconciliation.
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

Prototype / test build. It is not yet connected to ServiceTitan and is not production-ready.
