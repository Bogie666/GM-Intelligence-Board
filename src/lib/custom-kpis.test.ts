import { describe, expect, it } from "vitest";
import { getMetrics, locations } from "./demo-data";
import {
  CUSTOM_KPI_STORAGE_KEY,
  createCustomKpiDraft,
  duplicateCustomKpiDefinition,
  evaluateCustomKpis,
  readCustomKpiStore,
  runCustomKpiValidation,
  slugifyKpiKey,
  type CustomKpiDefinition,
} from "./custom-kpis";

const now = "2026-08-14T12:00:00.000Z";
const catalog = getMetrics(locations[0]);

function validDraft(overrides: Partial<CustomKpiDefinition> = {}): CustomKpiDefinition {
  return {
    ...createCustomKpiDraft("custom-test", now),
    key: "digital-booking-efficiency",
    title: "Digital Booking Efficiency",
    definition: "Digital bookings divided by qualified digital visits for the selected reporting scope.",
    owner: "Marketing",
    subtitle: "Bookings as a share of qualified visits",
    type: "derived",
    leftMetricId: "digital-bookings",
    operation: "percent",
    rightMetricId: "digital-visits",
    kind: "percent",
    goal: 5,
    releaseNote: "Approved portfolio conversion KPI",
    ...overrides,
  };
}

function memoryStorage(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key: string) { return data.get(key) ?? null; },
    setItem(key: string, value: string) { data.set(key, value); },
    value(key: string) { return data.get(key); },
  };
}

describe("custom KPI governance", () => {
  it("generates stable safe keys", () => {
    expect(slugifyKpiKey("  5-Star Review Pace / MTD ")).toBe("5-star-review-pace-mtd");
  });

  it("duplicates a KPI with a new immutable identity and independent mutable arrays", () => {
    const original = validDraft({
      id: "custom-original",
      status: "published",
      version: 4,
      locationIds: ["sierra-albuquerque"],
      roles: ["general-manager"],
      templateIds: ["gm-daily"],
      publishedAt: now,
    });
    const duplicate = duplicateCustomKpiDefinition(original, "custom-copy-12345678", "2026-08-15T02:00:00.000Z");

    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.key).not.toBe(original.key);
    expect(duplicate).toMatchObject({
      id: "custom-copy-12345678",
      status: "draft",
      version: 1,
      title: `${original.title} copy`,
      publishedAt: undefined,
      validatedAt: undefined,
      releaseNote: "",
    });
    expect(duplicate.locationIds).not.toBe(original.locationIds);
    expect(duplicate.roles).not.toBe(original.roles);
    expect(duplicate.templateIds).not.toBe(original.templateIds);
    expect(original).toMatchObject({ id: "custom-original", status: "published", version: 4, publishedAt: now });
  });

  it("evaluates a governed percentage formula without rounding the calculation", () => {
    const definition = validDraft({ leftMetricId: "calls-booked", rightMetricId: "inbound-calls" });
    const result = evaluateCustomKpis([definition], catalog).get(definition.id);
    expect(result?.state).toBe("available");
    expect(result?.value).toBeCloseTo(70, 8);
    expect(result?.source).toBe("Derived");
  });

  it("returns unavailable instead of zero when a denominator is zero", () => {
    const definition = validDraft({ rightMetricId: "electrical-revenue", operation: "divide" });
    const result = evaluateCustomKpis([definition], catalog).get(definition.id);
    expect(result?.state).toBe("unavailable");
    expect(result?.reason).toContain("unavailable");
  });

  it("keeps disconnected external data unavailable", () => {
    const definition = validDraft({ type: "external", provider: "GA4", externalMetricKey: "sessions", manualValue: undefined, leftMetricId: undefined, rightMetricId: undefined, operation: undefined });
    const result = evaluateCustomKpis([definition], catalog).get(definition.id);
    expect(result?.state).toBe("unavailable");
    expect(result?.value).toBeUndefined();
  });

  it("requires a dataset ID for Domo KPIs and preserves Domo lineage", () => {
    const missingDataset = validDraft({
      type: "external",
      provider: "Domo",
      externalMetricKey: "revenue_actual",
      manualValue: 100,
      asOf: "2026-08-14",
      leftMetricId: undefined,
      rightMetricId: undefined,
      operation: undefined,
    });
    const invalid = runCustomKpiValidation(missingDataset, catalog, []);
    expect(invalid.issues.some((issue) => issue.code === "domo-dataset" && issue.severity === "error")).toBe(true);

    const definition = { ...missingDataset, externalDatasetId: "financial-history" };
    const valid = runCustomKpiValidation(definition, catalog, []);
    expect(valid.issues.some((issue) => issue.code === "domo-dataset")).toBe(false);
    expect(evaluateCustomKpis([definition], catalog).get(definition.id)?.source).toBe("Domo");
  });

  it("blocks publication when required observation data is absent", () => {
    const definition = validDraft({ type: "manual", manualValue: undefined, asOf: undefined, leftMetricId: undefined, rightMetricId: undefined, operation: undefined });
    const validation = runCustomKpiValidation(definition, catalog, []);
    expect(validation.issues.some((issue) => issue.code === "manual-value" && issue.severity === "error")).toBe(true);
    expect(validation.checks.some((check) => check.status === "fail")).toBe(true);
  });

  it("migrates valid v1 metrics once and preserves manual lineage", () => {
    const storage = memoryStorage({
      "gmib.custom-metrics.v1": JSON.stringify([{ id: "legacy-1", title: "Legacy Reviews", section: "executive", source: "GA4", actual: 42, goal: 50, kind: "number", subtitle: "Old form" }]),
    });
    const store = readCustomKpiStore(storage, now);
    expect(store.schemaVersion).toBe(2);
    expect(store.definitions).toHaveLength(1);
    expect(store.definitions[0]).toMatchObject({ id: "legacy-1", type: "manual", status: "published", migratedFromLegacy: true, manualValue: 42 });
    expect(storage.value(CUSTOM_KPI_STORAGE_KEY)).toBeTruthy();
  });

  it("treats an intentionally empty v2 store as authoritative", () => {
    const storage = memoryStorage({
      [CUSTOM_KPI_STORAGE_KEY]: JSON.stringify({ schemaVersion: 2, definitions: [] }),
      "gmib.custom-metrics.v1": JSON.stringify([{ id: "legacy-1", title: "Legacy", actual: 1 }]),
    });
    expect(readCustomKpiStore(storage, now).definitions).toEqual([]);
  });
});
