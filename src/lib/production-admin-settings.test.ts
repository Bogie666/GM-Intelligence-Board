import { describe, expect, it } from "vitest";
import {
  endpointRecipeConfigurationExample,
  validateEndpointRecipeBindingConfiguration,
} from "./production-admin-settings";

describe("endpoint recipe draft configuration", () => {
  it("accepts reviewed job-type and business-unit mappings", () => {
    expect(validateEndpointRecipeBindingConfiguration(
      "completed-job-type-count",
      2,
      { includedJobTypeIds: [101, "202"], membershipRequired: true },
      { includedBusinessUnitIds: [7, "8"] },
    )).toEqual({ ok: true });
  });

  it("requires live job-type IDs instead of allowing an empty recipe placeholder", () => {
    expect(validateEndpointRecipeBindingConfiguration(
      "completed-job-type-count",
      2,
      endpointRecipeConfigurationExample("completed-job-type-count", 2).parameterValues,
      {},
    )).toMatchObject({ ok: false, fieldErrors: { parameterValues: expect.stringContaining("includedJobTypeIds") } });
  });

  it("rejects browser-authored parameters and malformed business-unit mappings", () => {
    expect(validateEndpointRecipeBindingConfiguration(
      "sales-close-rate",
      2,
      { soldThreshold: 1.01, endpoint: "https://untrusted.example" },
      { includedBusinessUnitIds: [] },
    )).toMatchObject({
      ok: false,
      fieldErrors: {
        parameterValues: expect.stringContaining("only optional soldThreshold"),
        businessUnitMappings: expect.stringContaining("non-empty"),
      },
    });
  });

  it("requires an explicit business-unit scope for scheduled pipeline v2", () => {
    expect(validateEndpointRecipeBindingConfiguration("sold-estimates-value", 2, {}, {}))
      .toMatchObject({ ok: false, fieldErrors: { businessUnitMappings: expect.stringContaining("requires") } });
    expect(validateEndpointRecipeBindingConfiguration(
      "sold-estimates-value", 2, {}, { includedBusinessUnitIds: [101, "202"] },
    )).toEqual({ ok: true });
  });

  it("keeps recipes with no parameter contract empty", () => {
    expect(validateEndpointRecipeBindingConfiguration("completed-revenue", 2, {}, {})).toEqual({ ok: true });
    expect(validateEndpointRecipeBindingConfiguration("completed-revenue", 2, { query: "browser-authored" }, {}))
      .toMatchObject({ ok: false, fieldErrors: { parameterValues: expect.any(String) } });
  });
});
