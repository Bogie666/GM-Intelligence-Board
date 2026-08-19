import { describe, expect, it } from "vitest";
import {
  getAdminSetupMilestones,
  isProductionAdminSection,
  parseProductionAdminSection,
} from "./admin-navigation";

describe("production admin navigation", () => {
  it("accepts supported URL sections and rejects arbitrary values", () => {
    expect(isProductionAdminSection("connections")).toBe(true);
    expect(isProductionAdminSection("database-settings")).toBe(false);
    expect(parseProductionAdminSection(["kpis", "overview"])).toBe("kpis");
    expect(parseProductionAdminSection("unknown")).toBe("overview");
  });

  it("derives setup progress only from persisted configuration signals", () => {
    const milestones = getAdminSetupMilestones({
      activeLocationCount: 2,
      enabledConnectionCount: 1,
      hasValidatedConnection: false,
      assignedActiveLocationCount: 1,
      discoveredBusinessUnitCount: 0,
      mappedBusinessUnitCount: 0,
    });

    expect(milestones.map((milestone) => [milestone.id, milestone.complete])).toEqual([
      ["locations", true],
      ["credentials", true],
      ["validation", false],
      ["assignments", true],
      ["discovery", false],
      ["mappings", false],
    ]);
    expect(milestones.filter((milestone) => milestone.complete)).toHaveLength(3);
  });
});
