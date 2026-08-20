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
import { deriveBindingPeriod } from "./run-data-source-ingestion.mjs";

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
      "active-memberships@1", "average-invoice-ticket@1", "completed-appointments@1",
      "completed-jobs-count@1", "completed-revenue@1", "inbound-call-booking-rate@1",
      "inbound-calls-booked@1", "inbound-calls-not-booked@1", "sales-close-rate@1",
    ],
  );
});

test("unknown recipes fail closed", () => {
  assert.throws(() => getEndpointRecipeExecution("unknown", 1), EndpointIngestionError);
  assert.throws(() => getEndpointRecipeExecution("completed-revenue", 2), EndpointIngestionError);
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
