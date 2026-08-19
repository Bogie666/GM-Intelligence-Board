import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerInputError,
  buildReportParameters,
  makeObservationIdempotencyKey,
  parseCredentialPayload,
  parsePeriod,
  parseReportDataResponse,
  reduceReportRows,
  toFiniteNumber,
} from "./lib/servicetitan-report.mjs";
import { fetchWithPolicy } from "./ingest-servicetitan-report.mjs";

const fields = [{ name: "Revenue" }, { name: "Booked" }, { name: "Eligible" }];

test("credential parser accepts the exact secret contract", () => {
  assert.deepEqual(parseCredentialPayload(JSON.stringify({ clientId: "client-id-123", clientSecret: "client-secret-123", appKey: "app-key-123" })), {
    clientId: "client-id-123",
    clientSecret: "client-secret-123",
    appKey: "app-key-123",
  });
});

test("credential parser rejects extra and missing fields", () => {
  assert.throws(() => parseCredentialPayload(JSON.stringify({ clientId: "client-id-123", clientSecret: "client-secret-123", appKey: "app-key-123", token: "forbidden" })), WorkerInputError);
  assert.throws(() => parseCredentialPayload(JSON.stringify({ clientId: "client-id-123", clientSecret: "client-secret-123" })), WorkerInputError);
  assert.throws(() => parseCredentialPayload("not-json"), WorkerInputError);
});

test("report parameters replace only exact period placeholders", () => {
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-08-02T00:00:00.000Z");
  assert.deepEqual(buildReportParameters({ To: "$periodEndDate", From: "$periodStartIso", Literal: "before-$periodStartIso", Ids: [1, 2] }, start, end), [
    { name: "From", value: "2026-08-01T00:00:00.000Z" },
    { name: "Ids", value: [1, 2] },
    { name: "Literal", value: "before-$periodStartIso" },
    { name: "To", value: "2026-08-02" },
  ]);
});

test("report response enforces exact ordered schema and row width", () => {
  assert.deepEqual(parseReportDataResponse({ fields: [{ name: "Revenue" }, { name: "Booked" }, { name: "Eligible" }], data: [["10", 2, 4]], hasMore: false }, fields), {
    fields: ["Revenue", "Booked", "Eligible"], rows: [["10", 2, 4]], hasMore: false,
    observedSchemaFingerprint: "schema-v3.WyJSZXZlbnVlIiwiQm9va2VkIiwiRWxpZ2libGUiXQ",
  });
  assert.throws(() => parseReportDataResponse({ fields: [{ name: "Booked" }, { name: "Revenue" }, { name: "Eligible" }], data: [], hasMore: false }, fields), /schema/);
  assert.throws(() => parseReportDataResponse({ fields: [{ name: "Revenue" }, { name: "Booked" }, { name: "Eligible" }], data: [[1, 2]], hasMore: false }, fields), /row/);
});

test("numeric parsing is strict and finite", () => {
  assert.equal(toFiniteNumber("-12.50", "Revenue"), -12.5);
  assert.equal(toFiniteNumber(7, "Revenue"), 7);
  for (const value of ["$1,000", "1,000", "12%", "Infinity", Infinity, null]) {
    assert.throws(() => toFiniteNumber(value, "Revenue"), WorkerInputError);
  }
});

test("reductions compute sum, average, count, and percent ratio while latest fails closed", () => {
  const rows = [[10, 2, 4], [20, 3, 6]];
  const names = fields.map((field) => field.name);
  assert.equal(reduceReportRows({ rows, fields: names, reduction: "sum", valueField: "Revenue" }).decimalValue, "30");
  assert.equal(reduceReportRows({ rows, fields: names, reduction: "average", valueField: "Revenue" }).decimalValue, "15");
  assert.equal(reduceReportRows({ rows, fields: names, reduction: "count" }).decimalValue, "2");
  assert.throws(() => reduceReportRows({ rows, fields: names, reduction: "latest", valueField: "Revenue" }), /ordering contract/);
  const ratio = reduceReportRows({ rows, fields: names, reduction: "ratio", numeratorField: "Booked", denominatorField: "Eligible", valueKind: "percent" });
  assert.equal(ratio.decimalValue, "50");
  assert.equal(ratio.decimalNumerator, "5");
  assert.equal(ratio.decimalDenominator, "10");
  assert.equal(reduceReportRows({ rows: [["9007199254740993"], ["0.01"]], fields: ["Revenue"], reduction: "sum", valueField: "Revenue" }).decimalValue, "9007199254740993.01");
});

test("reductions fail closed for empty data, missing fields, and zero denominator", () => {
  assert.throws(() => reduceReportRows({ rows: [], fields: ["Revenue"], reduction: "sum", valueField: "Revenue" }), /no rows/);
  assert.throws(() => reduceReportRows({ rows: [[1]], fields: ["Revenue"], reduction: "sum", valueField: "Missing" }), /not returned/);
  assert.throws(() => reduceReportRows({ rows: [[1, 0]], fields: ["Booked", "Eligible"], reduction: "ratio", numeratorField: "Booked", denominatorField: "Eligible", valueKind: "percent" }), /zero/);
});

test("idempotency key is stable and period-bound", () => {
  const base = { organizationId: "org", bindingId: "binding", sourceFingerprint: "fingerprint", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-02T00:00:00Z") };
  const one = makeObservationIdempotencyKey(base);
  const two = makeObservationIdempotencyKey(base);
  const different = makeObservationIdempotencyKey({ ...base, periodEnd: new Date("2026-08-03T00:00:00Z") });
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.equal(one, two);
  assert.notEqual(one, different);
});

test("period parser requires increasing valid timestamps", () => {
  assert.equal(parsePeriod("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z").start.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.throws(() => parsePeriod("bad", "2026-08-02T00:00:00Z"), WorkerInputError);
  assert.throws(() => parsePeriod("2026-08-02T00:00:00Z", "2026-08-01T00:00:00Z"), WorkerInputError);
});

test("network policy denies redirects instead of forwarding credentials", async () => {
  const originalFetch = globalThis.fetch;
  let observedRedirect;
  globalThis.fetch = async (_url, init) => {
    observedRedirect = init.redirect;
    return new Response(null, { status: 307, headers: { location: "https://untrusted.example/" } });
  };
  try {
    await assert.rejects(
      fetchWithPolicy("https://auth.servicetitan.io/connect/token", {
        method: "POST",
        headers: { authorization: "Bearer never-forward" },
      }, "oauth"),
      /HTTP 307/,
    );
    assert.equal(observedRedirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
