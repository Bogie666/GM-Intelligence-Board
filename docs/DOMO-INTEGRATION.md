# Domo Integration Framework

## Purpose

Domo is a candidate source for historical center financials, budgets, and other corporate datasets. This integration is designed as a governed ingestion source—not a browser-side query dependency.

## Current scaffold

The repository now includes:

- server-only OAuth client-credentials authentication using the Domo `data` scope
- in-process access-token caching with expiration safety margin
- DataSet API metadata listing (`GET /v1/datasets`)
- allowlisted dataset metadata retrieval (`GET /v1/datasets/{dataset_id}`)
- allowlisted CSV export (`GET /v1/datasets/{dataset_id}/data?includeHeader=true`)
- request timeouts and sanitized API errors
- an Admin → Domo configuration/status screen
- Domo as an external provider in the governed KPI builder
- a required Domo dataset ID and metric/column key for Domo KPI definitions

The current prototype does **not** persist Domo rows or populate live KPI values. External KPI previews remain clearly labeled manual snapshots until the warehouse mapping and scheduled materialization layer is implemented.

## Required server environment

```bash
DOMO_CLIENT_ID=...
DOMO_CLIENT_SECRET=...
DOMO_ALLOWED_DATASET_IDS=dataset-guid-1,dataset-guid-2
```

- `DOMO_CLIENT_ID` and `DOMO_CLIENT_SECRET` must be created as a Domo OAuth client with the `data` scope.
- `DOMO_ALLOWED_DATASET_IDS` is the application-level least-privilege boundary. Dataset detail and export calls fail closed when an ID is absent.
- Never expose these values through `NEXT_PUBLIC_*`, browser storage, logs, or API responses.

The public prototype's Admin check validates server configuration only. It deliberately does not use Domo credentials. Any future live connection-test or dataset-discovery route must first require authenticated Admin RBAC, throttling, and audit logging.

The DataSet API host is fixed to `https://api.domo.com` to avoid a configurable-host SSRF path.

## Recommended production flow

```text
Domo DataSet API
  → scheduled worker / queue
  → raw immutable extract or staging table
  → center/date/account mapping + validation
  → normalized external financial facts
  → reconciled KPI snapshots
  → GM Intelligence read API
```

Do not block dashboard page loads on live Domo latency. Historical datasets may be large; production ingestion should stream exports into object storage or a staging table rather than buffering the entire file in a Vercel request.

## Minimum dataset mapping contract

Each approved Domo dataset should have a governed mapping with:

- Domo dataset ID and display name
- business owner and technical owner
- tenant/center identifier column
- period/date column and timezone/fiscal-calendar rule
- metric/account column or fixed metric assignment
- actual, budget, or target value column
- currency and sign convention
- duplicate-key rule and expected grain
- full-refresh vs incremental strategy
- expected refresh cadence and stale threshold
- reconciliation total and acceptable variance

Missing or unmapped values must become an unavailable/degraded state, never a silent zero.

## Security boundary

- OAuth credentials and tokens remain server-side.
- Access tokens are cached only in process memory and are not persisted.
- Dataset reads require an explicit ID allowlist.
- The current public prototype exposes no dataset-list or data-export route.
- Add application authentication/RBAC before exposing dataset discovery or mapping APIs.
- Add audit events for connection tests, allowlist changes, mapping changes, and sync runs.

## Official references

- [Domo API Authentication](https://www.domo.com/docs/portal/1845fc11bbe5d-api-authentication)
- [Domo DataSet API](https://www.domo.com/docs/portal/3b1e3a7d5f420-data-set-api)
- [List DataSets](https://www.domo.com/docs/portal/72ae9b3e80374-list-data-sets)
- [Import and Export Data](https://www.domo.com/docs/portal/Connectors/api-connections/import-and-export-data)
