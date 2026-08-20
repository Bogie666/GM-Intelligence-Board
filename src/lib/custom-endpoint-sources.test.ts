import { describe, expect, it } from "vitest";
import {
  CUSTOM_ENDPOINT_CATEGORIES,
  CUSTOM_ENDPOINT_QUERY_MAX_BYTES,
  CUSTOM_ENDPOINT_QUERY_MAX_DEPTH,
  CUSTOM_ENDPOINT_QUERY_MAX_NODES,
  validateCustomEndpointQueryParameters,
  validateCustomEndpointSourceInput,
} from "./custom-endpoint-sources";

const validSource = {
  name: "Completed invoice revenue",
  description: "Invoice totals for the selected period.",
  category: "invoices",
  queryParameters: {
    invoicedOnOrAfter: "$periodStartIso",
    invoicedOnBefore: "$periodEndIso",
    status: ["Posted", "Paid"],
    includeAdjustments: true,
    minimumTotal: 0,
  },
  reduction: "sum",
  valueField: "summary.total",
  businessUnitField: "businessUnit.id",
};

function expectFieldError(result: ReturnType<typeof validateCustomEndpointSourceInput>, field: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.fieldErrors).toHaveProperty(field);
}

describe("custom endpoint source validation", () => {
  it("exposes exactly the seven worker and database categories", () => {
    expect(CUSTOM_ENDPOINT_CATEGORIES).toEqual([
      "jobs",
      "appointments",
      "invoices",
      "estimates",
      "memberships",
      "calls",
      "customers",
    ]);
  });

  it("normalizes printable names and descriptions and returns a governed contract", () => {
    const result = validateCustomEndpointSourceInput({
      ...validSource,
      name: "  Completed invoice revenue  ",
      description: "  Invoice totals.  ",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        ...validSource,
        name: "Completed invoice revenue",
        description: "Invoice totals.",
      },
    });
  });

  it.each(["jobs", "appointments", "invoices", "estimates", "memberships", "calls", "customers"])(
    "accepts the %s category",
    (category) => expect(validateCustomEndpointSourceInput({ ...validSource, category }).ok).toBe(true),
  );

  it.each(["job", "Invoices", "reports", "", null, 1])("rejects non-governed category %j", (category) => {
    expectFieldError(validateCustomEndpointSourceInput({ ...validSource, category }), "category");
  });

  it("requires recognized start and end placeholders and rejects literal or unbounded temporal contracts", () => {
    expectFieldError(validateCustomEndpointSourceInput({
      ...validSource,
      queryParameters: { status: "Completed" },
    }), "queryParameters");
    expectFieldError(validateCustomEndpointSourceInput({
      ...validSource,
      queryParameters: { completedOnOrAfter: "$periodStartIso" },
    }), "queryParameters");
    expectFieldError(validateCustomEndpointSourceInput({
      ...validSource,
      queryParameters: { completedOnOrAfter: "2026-08-01", completedBefore: "2026-08-02" },
    }), "queryParameters");
  });

  it("enforces the reduction/value-field relationship", () => {
    expect(validateCustomEndpointSourceInput({ ...validSource, reduction: "count", valueField: "" })).toMatchObject({
      ok: true,
      value: { reduction: "count", valueField: null },
    });
    expect(validateCustomEndpointSourceInput({ ...validSource, reduction: "count", valueField: null }).ok).toBe(true);
    expectFieldError(validateCustomEndpointSourceInput({ ...validSource, reduction: "count", valueField: "total" }), "valueField");
    expectFieldError(validateCustomEndpointSourceInput({ ...validSource, reduction: "sum", valueField: "" }), "valueField");
    expectFieldError(validateCustomEndpointSourceInput({ ...validSource, reduction: "average", valueField: ".total" }), "valueField");
    expectFieldError(validateCustomEndpointSourceInput({ ...validSource, reduction: "median" }), "reduction");
  });

  it("uses the deployed bounded field-path shape for value and business-unit fields", () => {
    const longest = `a${"0._".repeat(39)}00`;
    expect(longest).toHaveLength(120);
    expect(validateCustomEndpointSourceInput({ ...validSource, valueField: longest, businessUnitField: longest }).ok).toBe(true);
    for (const field of ["9value", "value-name", "value[0]", `a${"b".repeat(120)}`]) {
      expectFieldError(validateCustomEndpointSourceInput({ ...validSource, valueField: field }), "valueField");
      expectFieldError(validateCustomEndpointSourceInput({ ...validSource, businessUnitField: field }), "businessUnitField");
    }
    expect(validateCustomEndpointSourceInput({ ...validSource, businessUnitField: "" })).toMatchObject({
      ok: true,
      value: { businessUnitField: null },
    });
  });

  it("bounds and sanitizes name and description fields", () => {
    for (const name of ["", "   ", `n${"x".repeat(200)}`, "bad\u0000name", 42]) {
      expectFieldError(validateCustomEndpointSourceInput({ ...validSource, name }), "name");
    }
    expect(validateCustomEndpointSourceInput({ ...validSource, name: "n".repeat(200) }).ok).toBe(true);
    expect(validateCustomEndpointSourceInput({ ...validSource, description: "d".repeat(500) }).ok).toBe(true);
    for (const description of [`d${"x".repeat(500)}`, "bad\u007fdescription", null]) {
      expectFieldError(validateCustomEndpointSourceInput({ ...validSource, description }), "description");
    }
  });
});

describe("custom endpoint query validation", () => {
  it("accepts an object or JSON object text and preserves bounded scalar/list values", () => {
    const query = {
      active: true,
      amount: -10.5,
      status: ["Open", 2, false],
      emptyText: "",
    };
    expect(validateCustomEndpointQueryParameters(query)).toEqual({ ok: true, value: query });
    expect(validateCustomEndpointQueryParameters(JSON.stringify(query))).toEqual({ ok: true, value: query });
  });

  it("requires a plain JSON object", () => {
    for (const value of [null, [], "[]", "null", "not json", new Date(), Object.create(null)]) {
      expect(validateCustomEndpointQueryParameters(value).ok).toBe(false);
    }
  });

  it("enforces the worker key grammar and reserves pagination keys case-insensitively", () => {
    for (const key of ["1status", "status-code", "status_code", "a".repeat(65), "påge"]) {
      expect(validateCustomEndpointQueryParameters({ [key]: true })).toMatchObject({ ok: false });
    }
    for (const key of ["page", "PAGE", "PageSize", "PAGESIZE", "includeTotal", "INCLUDETOTAL"]) {
      expect(validateCustomEndpointQueryParameters({ [key]: true })).toMatchObject({ ok: false });
    }
    expect(validateCustomEndpointQueryParameters({ a: true, A1: false, pageSizeHint: 10 }).ok).toBe(true);
  });

  it("rejects credential-like keys recursively using the database vocabulary", () => {
    for (const key of [
      "oauthToken",
      "accessToken",
      "refresh_token",
      "clientSecret",
      "client-id",
      "appKey",
      "api_key",
      "password",
      "authorization",
      "bearerToken",
      "credentialValue",
      "secretReference",
    ]) {
      expect(validateCustomEndpointQueryParameters({ wrapper: { nested: [{ [key]: "do-not-store" }] } })).toMatchObject({ ok: false });
    }
  });

  it("allows only finite booleans, numbers, and bounded printable strings", () => {
    expect(validateCustomEndpointQueryParameters({ text: "x".repeat(200), zero: 0, enabled: false }).ok).toBe(true);
    for (const value of ["x".repeat(201), "line\nbreak", Number.NaN, Number.POSITIVE_INFINITY, null, undefined, BigInt(1), {}, ["ok", null]]) {
      expect(validateCustomEndpointQueryParameters({ value }).ok).toBe(false);
    }
  });

  it("allows only nonempty scalar arrays with at most 50 entries", () => {
    expect(validateCustomEndpointQueryParameters({ ids: Array.from({ length: 50 }, (_, index) => index) }).ok).toBe(true);
    expect(validateCustomEndpointQueryParameters({ ids: [] }).ok).toBe(false);
    expect(validateCustomEndpointQueryParameters({ ids: Array.from({ length: 51 }, (_, index) => index) }).ok).toBe(false);
    expect(validateCustomEndpointQueryParameters({ ids: [[1]] }).ok).toBe(false);
  });

  it("limits the top-level parameter count to 24", () => {
    const accepted = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`key${index}`, index]));
    const rejected = { ...accepted, key24: 24 };
    expect(validateCustomEndpointQueryParameters(accepted).ok).toBe(true);
    expect(validateCustomEndpointQueryParameters(rejected).ok).toBe(false);
  });

  it("fails closed on excessive serialized bytes, nesting, and node count", () => {
    expect(CUSTOM_ENDPOINT_QUERY_MAX_BYTES).toBe(32 * 1024);
    expect(validateCustomEndpointQueryParameters({ value: "x".repeat(CUSTOM_ENDPOINT_QUERY_MAX_BYTES) }).ok).toBe(false);

    let deeplyNested: unknown = true;
    for (let index = 0; index <= CUSTOM_ENDPOINT_QUERY_MAX_DEPTH; index += 1) deeplyNested = { nested: deeplyNested };
    expect(validateCustomEndpointQueryParameters({ wrapper: deeplyNested }).ok).toBe(false);

    const tooManyNodes = { wrapper: Array.from({ length: CUSTOM_ENDPOINT_QUERY_MAX_NODES }, () => true) };
    expect(validateCustomEndpointQueryParameters(tooManyNodes).ok).toBe(false);
  });

  it("rejects cyclic input without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateCustomEndpointQueryParameters(cyclic)).not.toThrow();
    expect(validateCustomEndpointQueryParameters(cyclic).ok).toBe(false);
  });
});
