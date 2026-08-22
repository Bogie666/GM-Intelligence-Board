import { describe, expect, it } from "vitest";
import {
  createProductionDashboardCsv,
  formatProductionPeriod,
  formatProductionValue,
  getProductionPriorTrend,
  getProductionSparklinePoints,
  getSupportedProductionPeriods,
  productionDashboardExportFilename,
  productionPeriodKey,
  shapeProductionDashboardKpis,
} from "./production-dashboard";
import type { ProductionKpiStatus } from "./tenant-context";

function kpi(overrides: Partial<ProductionKpiStatus> = {}): ProductionKpiStatus {
  return {
    bindingId: "binding-1",
    definitionId: "definition-1",
    kpiKey: "revenue",
    title: "Revenue",
    section: "executive",
    valueKind: "currency",
    percentValueScale: "ratio",
    subtitle: "Revenue collected in the selected period.",
    sourceSystem: "ServiceTitan",
    locationId: "location-1",
    locationName: "Dallas",
    sourceStatus: "Approved governed source",
    value: 100,
    priorValue: 80,
    periodEnd: "2026-08-18T23:59:59.000Z",
    observedAt: "2026-08-19T01:00:00.000Z",
    confidence: "high",
    health: "current",
    ...overrides,
  };
}

describe("production dashboard shaping", () => {
  it("derives stable UTC period keys and rejects invalid timestamps", () => {
    expect(productionPeriodKey("2026-08-18T23:59:59-05:00")).toBe("2026-08-19");
    expect(productionPeriodKey("invalid")).toBeNull();
    expect(formatProductionPeriod(null)).toBe("Period unavailable");
  });

  it("lists only periods with observations in the selected location", () => {
    const rows = [
      kpi(),
      kpi({ bindingId: "binding-2", periodEnd: "2026-08-17T23:59:59.000Z" }),
      kpi({ bindingId: "binding-3", locationId: "location-2", periodEnd: "2026-08-19T23:59:59.000Z" }),
      kpi({ bindingId: "binding-4", value: null, periodEnd: "2026-08-20T23:59:59.000Z" }),
      kpi({ bindingId: "binding-5", section: "revenue", periodEnd: "2026-08-21T23:59:59.000Z" }),
    ];
    expect(getSupportedProductionPeriods(rows, "location-1", "executive").map((period) => period.value)).toEqual(["2026-08-18", "2026-08-17"]);
  });

  it("keeps one section and one exact location while retaining catalog-level unavailable definitions", () => {
    const rows = [
      kpi(),
      kpi({ bindingId: "binding-2", locationId: "location-2" }),
      kpi({ bindingId: "binding-3", section: "revenue" }),
      kpi({ bindingId: null, locationId: null, kpiKey: "catalog-only", title: "Catalog only", value: null }),
    ];
    const result = shapeProductionDashboardKpis({ kpis: rows, locationId: "location-1", section: "executive", period: null });
    expect(result.map((row) => row.title)).toEqual(["Catalog only", "Revenue"]);
  });

  it("returns a truthful unavailable card when a selected period is absent", () => {
    const [result] = shapeProductionDashboardKpis({ kpis: [kpi()], locationId: "location-1", section: "executive", period: "2026-08-01" });
    expect(result.value).toBeNull();
    expect(result.health).toBe("unavailable");
    expect(result.periodAvailable).toBe(false);
    expect(result.sourceStatus).toContain("No governed observation is available");
  });

  it("formats percentages across ratio-backed and already-scaled source contracts", () => {
    expect(formatProductionValue(1250, "currency")).toBe("$1,250");
    expect(formatProductionValue(0.7, "percent", "ratio")).toBe("70%");
    expect(formatProductionValue(0.6666666666666666, "percent", "ratio")).toBe("66.7%");
    expect(formatProductionValue(70, "percent", "whole")).toBe("70%");
    expect(formatProductionValue(0.5, "percent", "whole")).toBe("0.5%");
    expect(formatProductionValue(null, "number")).toBe("Unavailable");
    expect(getProductionPriorTrend(kpi())?.changeLabel).toBe("+25.0% vs prior");
    expect(getProductionPriorTrend(kpi({ priorValue: 0 }))?.percentage).toBeNull();

    const ratioTrend = getProductionPriorTrend(kpi({ valueKind: "percent", value: 0.7, priorValue: 0.5 }));
    expect(ratioTrend?.priorLabel).toBe("50%");
    expect(ratioTrend?.changeLabel).toBe("+40.0% vs prior");
    expect(getProductionPriorTrend(kpi({ valueKind: "percent", value: 0.7, priorValue: 0 }))?.changeLabel)
      .toBe("+70% vs prior");
  });

  it("normalizes percentage sparkline geometry across source storage contracts", () => {
    const ratioPoints = getProductionSparklinePoints(kpi({
      valueKind: "percent",
      percentValueScale: "ratio",
      priorValue: 0.5,
      value: 0.7,
    }));
    const wholePoints = getProductionSparklinePoints(kpi({
      valueKind: "percent",
      percentValueScale: "whole",
      priorValue: 50,
      value: 70,
    }));
    expect(ratioPoints).toBe(wholePoints);
    expect(ratioPoints).toBe("0,32 120,5");
    expect(getProductionSparklinePoints(kpi({ value: null }))).toBeNull();
  });

  it("exports governed fields and neutralizes spreadsheet formulas", () => {
    const csv = createProductionDashboardCsv([{ ...kpi({ title: "=HYPERLINK(\"bad\")" }), periodAvailable: true }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("ServiceTitan");
    expect(csv).toContain("high");
    expect(csv).toContain("Current");
  });

  it("exports ratio-backed percentage actuals and priors on the 0–100 scale", () => {
    const csv = createProductionDashboardCsv([{
      ...kpi({ valueKind: "percent", value: 0.7, priorValue: 0.5 }),
      periodAvailable: true,
    }]);
    expect(csv).toContain("70%,50%,'+40.0% vs prior");
  });

  it("preserves low already-scaled percentages in trends and CSV exports", () => {
    const wholePercent = {
      ...kpi({
        title: "Low Whole-Scale Rate",
        valueKind: "percent",
        percentValueScale: "whole",
        value: 0.5,
        priorValue: 0.25,
      }),
      periodAvailable: true,
    };
    expect(getProductionPriorTrend(wholePercent)?.priorLabel).toBe("0.3%");
    expect(createProductionDashboardCsv([wholePercent])).toContain("0.5%,0.3%,'+100.0% vs prior");
  });

  it("creates a filesystem-safe contextual export filename", () => {
    expect(productionDashboardExportFilename({ organizationSlug: "Brand / One", locationKey: "Dallas #1", section: "sales", period: "2026-08-18" }))
      .toBe("gm-intelligence-brand-one-dallas-1-sales-2026-08-18.csv");
  });
});
