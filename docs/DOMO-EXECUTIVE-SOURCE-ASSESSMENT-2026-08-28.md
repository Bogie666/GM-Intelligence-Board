# Domo Executive Source Assessment — 2026-08-28

## Decision summary

1. **Budget:** Use `Map - Budgets (2.0)` as the preferred Domo source after adding a governed split month/year period contract. Keep the 2026 budget workbook as reconciliation evidence, not as the runtime source.
2. **Completed revenue:** Keep the existing direct ServiceTitan completed-revenue recipe as canonical. Do not substitute job revenue or bulk Domo invoice exports without a separately approved recognition contract.
3. **Jobs and appointments:** Keep bounded direct ServiceTitan endpoint recipes. Current Domo datasets are fresh but exceed the governed export limits by orders of magnitude.
4. **Sold pipeline:** Keep `sold-estimates-value@2`. The flattened Domo estimates dataset is item-grain and unsafe for canonical estimate valuation without a dedicated deduplication dataflow.
5. **Operational targets:** `Adaptive - Actuals vs Budget` is the strongest secondary Domo candidate for future appointment, close-rate, success-rate, average-ticket, and RPA targets. It requires semantic reconciliation before binding.

No Domo dataset was approved, bound, migrated, or deployed during discovery.

## Ranked candidates

### 1. Map - Budgets (2.0) — recommended budget source

- Dataset ID: `259fcf40-c679-480e-80b6-107ce9716b7e`
- Owner: David Hinson
- Data current: 2026-08-27 17:49 UTC
- Grain: one mapped location/month/year row
- Size: 896 rows, 8 columns
- Fields: `Master Location`, `Region`, `Month`, `Year`, `Budget`, `GM Club Budget`, `GM Estimate`, `GM Estimate Sold On`
- Lex 2026 rows: 12
- Lex August 2026 budget: **$2,486,921.00**
- Lex 2026 annual total: **$24,745,382.52**

**Decision:** Approved as the preferred candidate for monthly revenue budget semantics, subject to the source-contract enhancement and governed binding approval.

### 2. 2026 Budget Book - Domo Upload.xlsx — reconciliation control

- Dataset ID: `4066ebfb-3a07-46eb-943b-0f6984528ea2`
- Owner: David Hinson
- Data current: 2026-08-11 15:34 UTC
- Grain: tenant/master-business-unit row with one column per month
- Size: 260 rows, 14 columns
- Lex rows: 13 master business units
- Lex August 2026 budget: **$2,486,921.00**
- Lex 2026 annual total: **$24,688,266.45**

**Reconciliation:** August agrees exactly with the mapped source. The annual sources differ by **$57,116.07**, or **0.231%**. All variance occurs in January through April; May through December match. This makes the workbook suitable as evidence but not as the dynamic runtime source.

### 3. Adaptive - Actuals vs Budget — future driver-target candidate

- Dataset ID: `9e391bb6-adff-4d6d-83e2-6666327a979e`
- Data current: 2026-08-28 00:01 UTC
- Size: 32,910 rows; 989 rows match Lex
- Key dimensions: completion year/month, master location, technician level/type, revenue type
- Candidate measures: appointments/day, close rate, technician success rate, technician-lead average ticket, advisor average ticket, service RPA

**Decision:** Candidate only. Before approval, reconcile each measure to an independently calculated Lex period and document whether values represent actuals, targets, or both.

### 4. Jobs and Revenue - Vikas — useful for analyst reconciliation, not governed ingestion

- Dataset ID: `2b7487ad-c7b4-4680-97b1-c54e80254ab3`
- Owner: Kim Meltzer
- Data current: 2026-08-28 14:49 UTC
- Size: 4,022,064 rows, 19 columns
- Key fields: completion date, master location, business unit, job type, campaign, job status, customer ID, job number, total revenue

**Decision:** Do not bind. It exceeds the worker's 250,000-row and 24 MB export limits, and `Total_Revenue` is job-grain rather than the currently governed invoice/completed-revenue contract.

### 5. INT | Service Titan | TTM Invoices (Created On) — semantically promising, operationally ineligible

- Dataset ID: `0004060e-f0d5-404c-a5ed-1fa3aa16b4e1`
- Owner: Rachael Shorb
- Data current: 2026-08-28 15:03 UTC
- Size: 6,503,653 rows, 96 columns

**Decision:** Do not bind through full export. A compact tenant/location/month dataflow would be required, followed by reconciliation to the direct ServiceTitan revenue recipe.

### 6. Raw ServiceTitan jobs, appointments, and estimates — reject for current Domo worker

- Jobs: `5a4ad754-2be3-4712-baf2-ea907e9e0d60` — 10,426,664 rows
- Appointments: `a408455c-6642-47ab-8eb6-9e5f63831224` — 10,122,405 rows
- Estimates: `1abe47f9-dac6-4abe-93b9-c0dd9e986105` — 23,400,392 rows
- Owner: David Hinson
- Data current: 2026-08-28

**Decision:** Do not bind. Use bounded direct ServiceTitan queries. The estimate source is flattened to item grain, which creates material double-counting risk for sold estimate value.

## Rejected or deprioritized sources

- `KPI Budgets for Master Jobs`: no Lex location rows and data last updated 2026-04-20.
- `REF | Budget`: historical reference dataset last updated 2025-01-31.
- `Budgets`: obsolete dataset last updated 2021-04-19.
- `Intacct - ST Revenue`: stale since 2025-10-24 and too large for governed export.
- `Forecast`: weather forecast data, not financial forecast data.

## Runtime blocker and required implementation

The current Domo worker supports:

- one optional equality filter;
- one optional ISO-style date column;
- bounded full-dataset CSV export;
- 24 MB and 250,000-row limits.

`Map - Budgets (2.0)` stores period in separate text `Month` and `Year` columns while location must also be filtered. It cannot be safely bound through the current contract without either dropping location scope or dropping period scope.

The next implementation should add a governed `month_year` period mode with:

- required `monthColumn` and `yearColumn`;
- exact month-name/number parsing;
- local-period filtering before reduction;
- independent location equality filter;
- fail-closed behavior for malformed or duplicate location/month rows;
- configuration fingerprinting and approval evidence for all period/filter fields;
- regression coverage for month boundaries, duplicate rows, bad years/months, and absent Lex rows.

Until that enhancement is migrated and approved, budget must remain an existing governed target/manual publication—not an unscoped Domo sum.
