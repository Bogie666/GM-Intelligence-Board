import assert from "node:assert/strict";
import test from "node:test";
import {
  EndpointIngestionError,
  ENDPOINT_CATEGORY_PATHS,
  ENDPOINT_RECIPE_EXECUTIONS,
  buildEndpointQuery,
  executeEndpointRecipe,
  executeCustomEndpointSource,
  getEndpointRecipeExecution,
  makeEndpointObservationIdempotencyKey,
  validateCustomEndpointContract,
} from "./lib/servicetitan-endpoint-ingestion.mjs";
import { deriveBindingPeriod, deriveObservationPeriod } from "./run-data-source-ingestion.mjs";

const PERIOD = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-02T00:00:00.000Z"),
};
const CREDENTIALS = { clientId: "client-id-123", clientSecret: "client-secret-123", appKey: "app-key-123" };
const ORG = "e7000000-0000-4000-8000-000000000001";
const BINDING = "e7000000-0000-4000-8000-000000000002";

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function fetchStub(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const asString = String(url);
      for (const [match, responder] of routes) {
        if (asString.includes(match)) return responder(asString, init);
      }
      throw new Error(`Unexpected URL in test: ${asString}`);
    },
  };
}

const tokenRoute = ["/connect/token", () => jsonResponse({ access_token: "a".repeat(40) })];

test("every migration-owned recipe version has an execution contract and category path", () => {
  for (const key of Object.keys(ENDPOINT_RECIPE_EXECUTIONS)) {
    const execution = ENDPOINT_RECIPE_EXECUTIONS[key];
    assert.ok(ENDPOINT_CATEGORY_PATHS[execution.category], `category path missing for ${key}`);
    assert.equal(typeof execution.query, "function");
    assert.equal(typeof execution.reduce, "function");
  }
  assert.deepEqual(
    Object.keys(ENDPOINT_RECIPE_EXECUTIONS).sort(),
    [
      "active-memberships@1", "average-invoice-ticket@1", "average-invoice-ticket@2", "canceled-memberships@1", "canceled-memberships@2",
      "completed-appointments@1", "completed-job-type-count@2", "completed-jobs-count@1", "completed-revenue@1", "completed-revenue@2",
      "inbound-call-booking-rate@1", "inbound-call-booking-rate@2", "inbound-call-booking-rate@3", "inbound-calls-booked@1",
      "inbound-calls-count@1", "inbound-calls-not-booked@1", "jobs-with-appointments-count@1",
      "membership-net-growth@1", "membership-net-growth@2", "new-memberships@1", "new-memberships@2", "sales-close-rate@1", "sales-close-rate@2",
      "sales-opportunity-count@1", "sold-estimate-average-ticket@1", "sold-estimates-value@1",
    ],
  );
});

test("unknown recipes fail closed", () => {
  assert.throws(() => getEndpointRecipeExecution("unknown", 2), EndpointIngestionError);
  assert.throws(() => getEndpointRecipeExecution("completed-revenue", 3), EndpointIngestionError);
});

test("endpoint query builder resolves placeholders and rejects unsafe parameters", () => {
  assert.deepEqual(buildEndpointQuery({ b: "$periodEndDate", a: "$periodStartIso", ids: [1, 2] }, PERIOD), [
    ["a", "2026-08-01T00:00:00.000Z"],
    ["b", "2026-08-02"],
    ["ids", "1,2"],
  ]);
  assert.throws(() => buildEndpointQuery({ page: "2" }, PERIOD), EndpointIngestionError);
  assert.throws(() => buildEndpointQuery({ pageSize: "9999" }, PERIOD), EndpointIngestionError);
  assert.throws(() => buildEndpointQuery({ "bad key": "x" }, PERIOD), EndpointIngestionError);
  assert.throws(() => buildEndpointQuery({ nested: { object: true } }, PERIOD), EndpointIngestionError);
});

test("completed-revenue recipe sums invoice totals with Decimal precision", async () => {
  const { fetchImpl, calls } = fetchStub([
    tokenRoute,
    ["/accounting/v2/tenant/tenant-1/invoices", () => jsonResponse({
      page: 1, pageSize: 500, hasMore: false,
      data: [
        { id: 1, total: "1000.10", businessUnit: { id: 42 } },
        { id: 2, total: "0.20", businessUnit: { id: 42 } },
        { id: 3, total: "99.99", businessUnit: { id: 77 } },
      ],
    })],
  ]);
  const result = await executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "completed-revenue",
    recipeVersion: 1,
    businessUnitMappings: { includedBusinessUnitIds: [42] },
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "1000.3");
  assert.equal(result.rowCount, 2);
  assert.equal(result.totalRowCount, 3);
  const listCall = calls.find((call) => call.url.includes("/invoices"));
  assert.match(listCall.url, /invoicedOnOrAfter=2026-08-01T00%3A00%3A00.000Z/);
  assert.match(listCall.url, /pageSize=500/);
});

test("sales-close-rate recipe computes a governed ratio and rejects zero denominators", async () => {
  const { fetchImpl } = fetchStub([
    tokenRoute,
    ["/sales/v2/tenant/tenant-1/estimates", () => jsonResponse({
      page: 1, pageSize: 500, hasMore: false,
      data: [
        { id: 1, status: { name: "Sold" } },
        { id: 2, status: { name: "Open" } },
        { id: 3, status: { name: "sold" } },
        { id: 4, status: { name: "Dismissed" } },
      ],
    })],
  ]);
  const result = await executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "sales-close-rate",
    recipeVersion: 1,
    businessUnitMappings: {},
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "0.5");
  assert.equal(result.decimalNumerator, "2");
  assert.equal(result.decimalDenominator, "4");

  const { fetchImpl: emptyFetch } = fetchStub([
    tokenRoute,
    ["/sales/v2/tenant/tenant-1/estimates", () => jsonResponse({ page: 1, pageSize: 500, hasMore: false, data: [] })],
  ]);
  await assert.rejects(executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "sales-close-rate",
    recipeVersion: 1,
    businessUnitMappings: {},
    period: PERIOD,
    options: { fetchImpl: emptyFetch },
  }), (error) => error.code === "endpoint_denominator_zero");
});

test("completed-jobs-count recipe counts business-unit-scoped jobs with exclusive upper bound", async () => {
  const { fetchImpl, calls } = fetchStub([
    tokenRoute,
    ["/jpm/v2/tenant/tenant-1/jobs", () => jsonResponse({
      page: 1, pageSize: 500, hasMore: false,
      data: [
        { id: 1, businessUnitId: 42 },
        { id: 2, businessUnitId: 42 },
        { id: 3, businessUnitId: 77 },
      ],
    })],
  ]);
  const result = await executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "completed-jobs-count",
    recipeVersion: 1,
    businessUnitMappings: { includedBusinessUnitIds: [42] },
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "2");
  assert.equal(result.totalRowCount, 3);
  const listCall = calls.find((call) => call.url.includes("/jobs"));
  assert.match(listCall.url, /completedOnOrAfter=/);
  assert.match(listCall.url, /completedBefore=/);
  assert.doesNotMatch(listCall.url, /completedOnOrBefore=/);
});

test("average-invoice-ticket recipe divides Decimal totals by invoice count and fails closed on empty periods", async () => {
  const { fetchImpl } = fetchStub([
    tokenRoute,
    ["/accounting/v2/tenant/tenant-1/invoices", () => jsonResponse({
      page: 1, pageSize: 500, hasMore: false,
      data: [
        { id: 1, total: "100.10", businessUnit: { id: 42 } },
        { id: 2, total: "199.90", businessUnit: { id: 42 } },
      ],
    })],
  ]);
  const result = await executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "average-invoice-ticket",
    recipeVersion: 1,
    businessUnitMappings: { includedBusinessUnitIds: [42] },
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "150");
  assert.equal(result.decimalNumerator, "300");
  assert.equal(result.decimalDenominator, "2");

  const { fetchImpl: emptyFetch } = fetchStub([
    tokenRoute,
    ["/accounting/v2/tenant/tenant-1/invoices", () => jsonResponse({ page: 1, pageSize: 500, hasMore: false, data: [] })],
  ]);
  await assert.rejects(executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "average-invoice-ticket",
    recipeVersion: 1,
    businessUnitMappings: {},
    period: PERIOD,
    options: { fetchImpl: emptyFetch },
  }), (error) => error.code === "endpoint_denominator_zero");
});

test("inbound call booking recipes split booked and non-booked non-abandoned calls", async () => {
  const callsPayload = () => jsonResponse({
    page: 1, pageSize: 500, hasMore: false,
    data: [
      { id: 1, jobNumber: "J-100", callType: "Booked" },
      { id: 2, jobNumber: 200, callType: null },
      { id: 3, jobNumber: "", callType: "Unbooked" },
      { id: 4, callType: "Abandoned" },
      { id: 5, callType: "NotLead" },
    ],
  });
  const run = async (recipeId) => {
    const { fetchImpl, calls } = fetchStub([
      tokenRoute,
      ["/telecom/v2/tenant/tenant-1/calls", callsPayload],
    ]);
    const result = await executeEndpointRecipe({
      credentials: CREDENTIALS,
      environment: "production",
      tenantId: "tenant-1",
      recipeId,
      recipeVersion: 1,
      businessUnitMappings: {},
      period: PERIOD,
      options: { fetchImpl },
    });
    const listCall = calls.find((call) => call.url.includes("/calls"));
    assert.match(listCall.url, /direction=Inbound/);
    return result;
  };
  const booked = await run("inbound-calls-booked");
  assert.equal(booked.decimalValue, "2");
  const notBooked = await run("inbound-calls-not-booked");
  assert.equal(notBooked.decimalValue, "2");
});

test("endpoint pagination follows hasMore and enforces the page safety limit", async () => {
  let page = 0;
  const { fetchImpl } = fetchStub([
    tokenRoute,
    ["/memberships/v2/tenant/tenant-1/memberships", () => {
      page += 1;
      return jsonResponse({ page, pageSize: 500, hasMore: page < 3, data: [{ id: page, active: true }] });
    }],
  ]);
  const result = await executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "active-memberships",
    recipeVersion: 1,
    businessUnitMappings: {},
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "3");
  assert.equal(result.pageCount, 3);
});

test("malformed provider envelopes fail closed", async () => {
  const { fetchImpl } = fetchStub([
    tokenRoute,
    ["/memberships/v2/tenant/tenant-1/memberships", () => jsonResponse({ data: "not-an-array", hasMore: false })],
  ]);
  await assert.rejects(executeEndpointRecipe({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    recipeId: "active-memberships",
    recipeVersion: 1,
    businessUnitMappings: {},
    period: PERIOD,
    options: { fetchImpl },
  }), (error) => error.code === "endpoint_response_invalid");
});

test("custom endpoint contract validation is fail-closed", () => {
  const bounded = { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" };
  assert.ok(validateCustomEndpointContract({ category: "jobs", queryParameters: bounded, reduction: "count", valueField: "" }));
  assert.throws(() => validateCustomEndpointContract({ category: "jobs", queryParameters: { completedOnOrAfter: "$periodStartIso" }, reduction: "count", valueField: "" }), (error) => error.code === "endpoint_period_contract_invalid");
  assert.throws(() => validateCustomEndpointContract({ category: "jobs", queryParameters: { completedOnOrAfter: "2026-08-01", completedBefore: "2026-08-02" }, reduction: "count", valueField: "" }), (error) => error.code === "endpoint_period_contract_invalid");
  assert.throws(() => validateCustomEndpointContract({ category: "payroll", queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" }, reduction: "count", valueField: "" }), EndpointIngestionError);
  assert.throws(() => validateCustomEndpointContract({ category: "jobs", queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" }, reduction: "latest", valueField: "total" }), EndpointIngestionError);
  assert.throws(() => validateCustomEndpointContract({ category: "jobs", queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" }, reduction: "sum", valueField: "" }), EndpointIngestionError);
  assert.throws(() => validateCustomEndpointContract({ category: "jobs", queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" }, reduction: "count", valueField: "total" }), EndpointIngestionError);
});

test("custom endpoint execution sums nested value paths and filters business units", async () => {
  const { fetchImpl } = fetchStub([
    tokenRoute,
    ["/jpm/v2/tenant/tenant-1/jobs", () => jsonResponse({
      page: 1, pageSize: 500, hasMore: false,
      data: [
        { id: 1, businessUnitId: 42, summary: { total: "10.50" } },
        { id: 2, businessUnitId: 42, summary: { total: "0.25" } },
        { id: 3, businessUnitId: 9, summary: { total: "99" } },
      ],
    })],
  ]);
  const result = await executeCustomEndpointSource({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    category: "jobs",
    queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" },
    reduction: "sum",
    valueField: "summary.total",
    businessUnitMappings: { includedBusinessUnitIds: ["42"] },
    businessUnitField: "businessUnitId",
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "10.75");
  assert.equal(result.rowCount, 2);
});

test("custom endpoint average uses Decimal division and empty results fail closed", async () => {
  const { fetchImpl } = fetchStub([
    tokenRoute,
    ["/accounting/v2/tenant/tenant-1/invoices", () => jsonResponse({
      page: 1, pageSize: 500, hasMore: false,
      data: [{ id: 1, total: "1" }, { id: 2, total: "2" }],
    })],
  ]);
  const result = await executeCustomEndpointSource({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    category: "invoices",
    queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" },
    reduction: "average",
    valueField: "total",
    businessUnitMappings: {},
    businessUnitField: null,
    period: PERIOD,
    options: { fetchImpl },
  });
  assert.equal(result.decimalValue, "1.5");

  const { fetchImpl: emptyFetch } = fetchStub([
    tokenRoute,
    ["/accounting/v2/tenant/tenant-1/invoices", () => jsonResponse({ page: 1, pageSize: 500, hasMore: false, data: [] })],
  ]);
  await assert.rejects(executeCustomEndpointSource({
    credentials: CREDENTIALS,
    environment: "production",
    tenantId: "tenant-1",
    category: "invoices",
    queryParameters: { completedOnOrAfter: "$periodStartIso", completedBefore: "$periodEndIso" },
    reduction: "sum",
    valueField: "total",
    businessUnitMappings: {},
    businessUnitField: null,
    period: PERIOD,
    options: { fetchImpl: emptyFetch },
  }), (error) => error.code === "endpoint_empty");
});

test("idempotency keys are sha256 and identity-validated", () => {
  const key = makeEndpointObservationIdempotencyKey({
    organizationId: ORG,
    bindingId: BINDING,
    sourceFingerprint: "fingerprint-1",
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });
  assert.match(key, /^[0-9a-f]{64}$/);
  const repeat = makeEndpointObservationIdempotencyKey({
    organizationId: ORG,
    bindingId: BINDING,
    sourceFingerprint: "fingerprint-1",
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });
  assert.equal(key, repeat);
  assert.throws(() => makeEndpointObservationIdempotencyKey({
    organizationId: "not-a-uuid",
    bindingId: BINDING,
    sourceFingerprint: "fingerprint-1",
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  }), EndpointIngestionError);
});

test("worker period math produces trailing minute-aligned cadence windows", () => {
  const now = new Date("2026-08-20T15:37:42.500Z");
  const hourly = deriveBindingPeriod("1h", now);
  assert.equal(hourly.end.toISOString(), "2026-08-20T15:37:00.000Z");
  assert.equal(hourly.start.toISOString(), "2026-08-20T14:37:00.000Z");
  const daily = deriveBindingPeriod("24h", now);
  assert.equal(daily.start.toISOString(), "2026-08-19T15:37:00.000Z");
  assert.throws(() => deriveBindingPeriod("7d", now));
});

test("observation windows: trailing falls back to cadence math", () => {
  const now = new Date("2026-08-20T15:37:42.500Z");
  const period = deriveObservationPeriod({ observation_window: "trailing", refresh_interval: "1h" }, now);
  assert.equal(period.start.toISOString(), "2026-08-20T14:37:00.000Z");
  assert.equal(period.end.toISOString(), "2026-08-20T15:37:00.000Z");
  const legacy = deriveObservationPeriod({ refresh_interval: "15m" }, now);
  assert.equal(legacy.start.toISOString(), "2026-08-20T15:22:00.000Z");
});

test("observation windows: mtd anchors to local first-of-month midnight (CDT)", () => {
  const now = new Date("2026-08-20T15:37:42.500Z");
  const period = deriveObservationPeriod({
    observation_window: "mtd", refresh_interval: "15m", location_timezone: "America/Chicago",
  }, now);
  // 2026-08-01T00:00:00 America/Chicago (CDT, UTC-5) = 05:00Z.
  assert.equal(period.start.toISOString(), "2026-08-01T05:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-08-20T15:37:00.000Z");
});

test("observation windows: mtd respects standard time offsets (CST)", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const period = deriveObservationPeriod({
    observation_window: "mtd", refresh_interval: "1h", location_timezone: "America/Chicago",
  }, now);
  // 2026-01-01T00:00:00 America/Chicago (CST, UTC-6) = 06:00Z.
  assert.equal(period.start.toISOString(), "2026-01-01T06:00:00.000Z");
});

test("observation windows: today anchors to local midnight even across UTC date lines", () => {
  // 02:30Z on the 21st is still 21:30 on the 20th in Chicago.
  const now = new Date("2026-08-21T02:30:00.000Z");
  const period = deriveObservationPeriod({
    observation_window: "today", refresh_interval: "15m", location_timezone: "America/Chicago",
  }, now);
  assert.equal(period.start.toISOString(), "2026-08-20T05:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-08-21T02:30:00.000Z");
});

test("observation windows: calendar windows fail closed without a valid timezone", () => {
  const now = new Date("2026-08-20T15:37:00.000Z");
  assert.throws(() => deriveObservationPeriod({ observation_window: "mtd", refresh_interval: "1h" }, now),
    /timezone/i);
  assert.throws(() => deriveObservationPeriod({
    observation_window: "mtd", refresh_interval: "1h", location_timezone: "Mars/Olympus_Mons",
  }, now), /timezone/i);
  assert.throws(() => deriveObservationPeriod({
    observation_window: "yearly", refresh_interval: "1h", location_timezone: "America/Chicago",
  }, now), /not supported/i);
});

test("observation windows: empty calendar window at exact local midnight fails closed", () => {
  // Exactly local midnight in Chicago: 05:00:00Z on the same local day.
  const now = new Date("2026-08-20T05:00:00.000Z");
  assert.throws(() => deriveObservationPeriod({
    observation_window: "today", refresh_interval: "15m", location_timezone: "America/Chicago",
  }, now), /empty/i);
});

test("observation windows: ytd anchors to local January 1 midnight", () => {
  const now = new Date("2026-08-20T15:37:42.500Z");
  const period = deriveObservationPeriod({
    observation_window: "ytd", refresh_interval: "4h", location_timezone: "America/Chicago",
  }, now);
  // 2026-01-01T00:00:00 America/Chicago (CST, UTC-6) = 06:00Z.
  assert.equal(period.start.toISOString(), "2026-01-01T06:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-08-20T15:37:00.000Z");
});

test("tranche-1 recipes: inbound calls and booking rate v2 use job-number semantics", () => {
  const calls = [
    { direction: "Inbound", callType: "Booked", jobNumber: "123" },
    { direction: "Inbound", callType: "Unbooked", jobNumber: null },
    { direction: "Inbound", callType: "Abandoned", jobNumber: null },
    { direction: "Inbound", callType: "Excused", jobNumber: 456 },
  ];
  const countRecipe = getEndpointRecipeExecution("inbound-calls-count", 1);
  assert.equal(countRecipe.reduce(calls).decimalValue, "3"); // abandoned excluded
  const rate = getEndpointRecipeExecution("inbound-call-booking-rate", 2).reduce(calls);
  assert.equal(rate.decimalNumerator, "2");   // two calls carry job numbers
  assert.equal(rate.decimalDenominator, "4"); // total inbound (abandoned included)
});

test("inbound call booking rate v3 uses qualified inbound leads and booked-job outcomes", () => {
  const calls = [
    { jobNumber: "J-100", leadCall: { direction: "Inbound", duration: "00:02:15", callType: "Booked", reason: { lead: false } } },
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "00:01:00", callType: "Unbooked", reason: { lead: false } } },
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "00:00:35", callType: "Unbooked", reason: { lead: true } } },
    { jobNumber: 200, leadCall: { direction: "Inbound", duration: "00:00:42", callType: "Booked", reason: null } },
    { jobNumber: "EXISTING-1", leadCall: { direction: "Inbound", duration: "00:04:00", callType: "NotLead", reason: { lead: true } } },
    { jobNumber: "EXCUSED-1", leadCall: { direction: "Inbound", duration: "00:03:00", callType: "Excused", reason: { lead: true } } },
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "00:01:01", callType: "Abandoned", reason: null } },
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "00:00:20", callType: "Other", reason: { lead: true } } },
    { jobNumber: "OUTBOUND-1", leadCall: { direction: "Outbound", duration: "00:05:00", callType: "Booked", reason: { lead: true } } },
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "00:01:30", callType: "NotLead", reason: { lead: false } } },
  ];

  const recipe = getEndpointRecipeExecution("inbound-call-booking-rate", 3);
  const query = Object.fromEntries(recipe.query(PERIOD));
  assert.equal(query.direction, undefined, "unsupported direction query parameter must not be relied upon");

  const rate = recipe.reduce(calls);
  assert.equal(rate.decimalNumerator, "2");
  assert.equal(rate.decimalDenominator, "6");
  assert.equal(Number(rate.decimalValue).toFixed(4), "0.3333");
});

test("inbound call booking rate v3 fails closed on malformed governed call fields", () => {
  const recipe = getEndpointRecipeExecution("inbound-call-booking-rate", 3);
  assert.throws(() => recipe.reduce([{ jobNumber: "J-1" }]), (error) => error.code === "endpoint_response_invalid");
  assert.throws(() => recipe.reduce([
    { jobNumber: null, leadCall: { direction: "SchemaDrift", duration: "00:01:00", callType: "Unbooked" } },
  ]), (error) => error.code === "endpoint_response_invalid");
  assert.throws(() => recipe.reduce([
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "sixty seconds", callType: "Other" } },
  ]), (error) => error.code === "endpoint_response_invalid");

  const explicitUnbooked = recipe.reduce([
    { jobNumber: null, leadCall: { direction: "Inbound", duration: "not-required", callType: "Unbooked" } },
  ]);
  assert.equal(explicitUnbooked.decimalDenominator, "1", "explicit outcomes do not depend on duration metadata");
});

test("tranche-1 recipes: membership windows are enforced client-side", () => {
  const period = { start: new Date("2026-08-01T05:00:00Z"), end: new Date("2026-08-21T00:00:00Z") };
  const members = [
    { createdOn: "2026-08-05T12:00:00Z", status: "Active", cancellationDate: null },
    { createdOn: "2026-07-01T12:00:00Z", status: "Canceled", cancellationDate: "2026-08-10T00:00:00Z" },
    { createdOn: "2026-07-01T12:00:00Z", status: "Canceled", cancellationDate: "2025-11-14T00:00:00Z" },
    { createdOn: "2026-08-15T12:00:00Z", status: "Canceled", cancellationDate: "2026-08-18T00:00:00Z" },
  ];
  const canceled = getEndpointRecipeExecution("canceled-memberships", 1);
  assert.equal(canceled.reduce(members, period).decimalValue, "2"); // only in-period cancellations
  const net = getEndpointRecipeExecution("membership-net-growth", 1);
  assert.equal(net.reduce(members, period).decimalValue, "0"); // 2 created - 2 canceled
});

test("membership v2 recipes use timezone-aware start and effective-end events through period end", () => {
  const period = { start: new Date("2026-08-01T05:00:00Z"), end: new Date("2026-08-22T19:19:00Z") };
  const options = { timeZone: "America/Chicago" };
  const members = [
    // Starts on local August 1; UTC interpretation must not drop it before 05:00Z.
    { from: "2026-08-01", to: "2027-07-31", status: "Active" },
    { from: "2026-08-22T00:00:00", to: "2027-08-21", status: "Active" },
    // Future local start must not be counted MTD.
    { from: "2026-08-23", to: "2027-08-22", status: "Active" },
    // Created this month but started earlier: not a new-membership event.
    { createdOn: "2026-08-05T12:00:00Z", from: "2026-07-15", to: "2027-07-14", status: "Active" },
    // Cancellation event.
    { from: "2026-01-01", cancellationDate: "2026-08-10", to: "2026-12-31", status: "Canceled" },
    // Natural expiration counts even when status is Expired rather than Canceled.
    { from: "2025-08-15", cancellationDate: null, to: "2026-08-15", status: "Expired" },
    // Earliest effective end wins, regardless of current status.
    { from: "2025-08-18", cancellationDate: "2026-08-18", to: "2026-08-30", status: "Active" },
    // Future end date must not be counted MTD.
    { from: "2025-08-30", cancellationDate: null, to: "2026-08-30", status: "Active" },
  ];

  const created = getEndpointRecipeExecution("new-memberships", 2);
  const canceled = getEndpointRecipeExecution("canceled-memberships", 2);
  const net = getEndpointRecipeExecution("membership-net-growth", 2);
  assert.deepEqual(created.query(period), []);
  assert.deepEqual(canceled.query(period), []);
  assert.deepEqual(net.query(period), []);
  assert.equal(created.reduce(members, period, options).decimalValue, "2");
  assert.equal(canceled.reduce(members, period, options).decimalValue, "3");
  assert.deepEqual(net.reduce(members, period, options), {
    decimalValue: "-1",
    decimalNumerator: null,
    decimalDenominator: null,
    metricComponents: { newMemberships: 2, effectiveEnds: 3 },
  });
});

test("membership v2 recipes fail closed on missing timezone or malformed event dates", () => {
  const period = { start: new Date("2026-08-01T05:00:00Z"), end: new Date("2026-08-22T19:19:00Z") };
  const created = getEndpointRecipeExecution("new-memberships", 2);
  assert.throws(
    () => created.reduce([{ from: "2026-08-10" }], period, {}),
    (error) => error.code === "endpoint_timezone_invalid",
  );
  assert.throws(
    () => created.reduce([{ from: "2026-02-30" }], period, { timeZone: "America/Chicago" }),
    (error) => error.code === "endpoint_response_invalid",
  );
  for (const malformed of ["2026-08-10garbage", "2026-08-10T99:99:99Z", "0001-01-01garbage"]) {
    assert.throws(
      () => created.reduce([{ from: malformed }], period, { timeZone: "America/Chicago" }),
      (error) => error.code === "endpoint_response_invalid",
    );
  }
});

test("tranche-1 recipes: sold estimates sum subtotals of sold status only", () => {
  const estimates = [
    { status: { name: "Sold" }, subtotal: 2800 },
    { status: { name: "Sold" }, subtotal: 150.5 },
    { status: { name: "Open" }, subtotal: 99999 },
  ];
  const recipe = getEndpointRecipeExecution("sold-estimates-value", 1);
  assert.equal(recipe.reduce(estimates).decimalValue, "2950.5");
});

test("tranche-1 recipes: appointment-window jobs use period-bounded query filters", () => {
  const period = { start: new Date("2026-08-20T05:00:00Z"), end: new Date("2026-08-21T05:00:00Z") };
  const recipe = getEndpointRecipeExecution("jobs-with-appointments-count", 1);
  const query = Object.fromEntries(recipe.query(period));
  assert.equal(query.appointmentStartsOnOrAfter, "2026-08-20T05:00:00.000Z");
  assert.equal(query.appointmentStartsBefore, "2026-08-21T05:00:00.000Z");
  assert.equal(recipe.reduce([{}, {}, {}]).decimalValue, "3");
});

test("sales-close-rate@2: groups estimates by jobId, applies sold threshold", () => {
  const estimates = [
    // Job A: two Sold estimates, one above threshold → closed
    { jobId: 1001, status: { name: "Sold" }, subtotal: "85.0" },
    { jobId: 1001, status: { name: "Sold" }, subtotal: "2000.0" },
    // Job B: one Sold estimate below threshold → not closed
    { jobId: 1002, status: { name: "Sold" }, subtotal: "0.50" },
    // Job C: only Open → opportunity but not closed
    { jobId: 1003, status: { name: "Open" }, subtotal: "500.0" },
    // Job D: one Sold above threshold → closed
    { jobId: 1004, status: { name: "Sold" }, subtotal: "50.0" },
    // estimate with no jobId → ignored
    { status: { name: "Sold" }, subtotal: "100.0" },
  ];
  const recipe = getEndpointRecipeExecution("sales-close-rate", 2);
  const result = recipe.reduce(estimates, null, { parameterValues: { soldThreshold: "1.0" } });
  assert.equal(result.decimalNumerator, "2");  // Job 1001 and 1004 are closed
  assert.equal(result.decimalDenominator, "4"); // Jobs 1001, 1002, 1003, 1004 are opportunities
  assert.equal(result.decimalValue, "0.5");     // 2/4 = 50%
});

test("sales-close-rate@2: fails closed on invalid soldThreshold", () => {
  const recipe = getEndpointRecipeExecution("sales-close-rate", 2);
  assert.throws(() => recipe.reduce([], null, { parameterValues: { soldThreshold: "-1" } }), EndpointIngestionError);
  assert.throws(() => recipe.reduce([], null, { parameterValues: { soldThreshold: "not-a-number" } }), EndpointIngestionError);
});

test("sales-close-rate@2: empty estimates fails denominator zero", () => {
  const recipe = getEndpointRecipeExecution("sales-close-rate", 2);
  assert.throws(() => recipe.reduce([], null, {}), EndpointIngestionError);
});
