import { describe, expect, it } from "vitest";
import { defaultRoleTemplates, moveTemplateMetric, normalizeRoleTemplates } from "./layout-templates";

describe("role template configuration", () => {
  it("moves a KPI without mutating the stored order", () => {
    const initial = ["revenue", "booking", "sales"];
    expect(moveTemplateMetric(initial, "booking", -1)).toEqual(["booking", "revenue", "sales"]);
    expect(initial).toEqual(["revenue", "booking", "sales"]);
  });

  it("keeps a metric at the boundary", () => {
    const initial = ["revenue", "booking"];
    expect(moveTemplateMetric(initial, "revenue", -1)).toBe(initial);
  });

  it("drops invalid saved metric IDs while preserving valid selections", () => {
    const saved = [{
      ...defaultRoleTemplates[0],
      sections: { ...defaultRoleTemplates[0].sections, executive: ["revenue-mtd", "not-a-real-kpi"] },
    }];
    expect(normalizeRoleTemplates(saved)[0].sections.executive).toEqual(["revenue-mtd"]);
  });

  it("preserves published custom KPI IDs supplied by the catalog", () => {
    const saved = [{
      ...defaultRoleTemplates[0],
      sections: { ...defaultRoleTemplates[0].sections, executive: ["revenue-mtd", "custom-reviewed-kpi"] },
    }];
    expect(normalizeRoleTemplates(saved, ["custom-reviewed-kpi"])[0].sections.executive).toEqual(["revenue-mtd", "custom-reviewed-kpi"]);
  });

  it("restores defaults from malformed browser data", () => {
    expect(normalizeRoleTemplates({})).toEqual(defaultRoleTemplates);
  });
});
