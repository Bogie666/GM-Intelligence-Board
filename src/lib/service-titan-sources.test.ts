import { describe, expect, it } from "vitest";
import { createSeedConnectionStore } from "./demo-connections";
import {
  buildServiceTitanReportSource,
  createSeedServiceTitanSourceStore,
  normalizeServiceTitanSourceStore,
  readServiceTitanSourceStore,
  refreshOptionsForMethod,
  selectableServiceTitanEndpointRecipes,
  serviceTitanEndpointRecipes,
  staleHoursForRefresh,
  upsertServiceTitanReportSource,
  validateReportParameterValues,
  validateServiceTitanReportSourceInput,
  writeServiceTitanSourceStore,
  SERVICE_TITAN_SOURCE_STORAGE_KEY,
} from "./service-titan-sources";

function memoryStorage(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key: string) { return data.get(key) ?? null; },
    setItem(key: string, value: string) { data.set(key, value); },
    value(key: string) { return data.get(key); },
  };
}

describe("governed ServiceTitan sources", () => {
  it("exposes a finite, stricter cadence allowlist for saved reports", () => {
    expect(refreshOptionsForMethod("endpoint-recipe").map((item) => item.id)).toEqual(["15m", "30m", "1h", "4h", "24h"]);
    expect(refreshOptionsForMethod("saved-report").map((item) => item.id)).toEqual(["4h", "12h", "24h"]);
    expect(staleHoursForRefresh("15m")).toBe(1);
    expect(staleHoursForRefresh("24h")).toBe(36);
  });

  it("publishes only versioned endpoint recipes with method-specific refresh limits", () => {
    expect(serviceTitanEndpointRecipes.length).toBeGreaterThan(3);
    for (const recipe of serviceTitanEndpointRecipes) {
      expect(recipe.id.length).toBeGreaterThan(3);
      expect(recipe.version).toBeGreaterThan(0);
      expect(recipe.allowedRefreshIntervals).toContain(recipe.defaultRefreshInterval);
      expect(recipe.capability.length).toBeGreaterThan(0);
      expect(recipe.lineage.length).toBeGreaterThan(0);
    }
  });

  it("retires inbound booking-rate v1 and v2 from new selections while retaining historical lineage", () => {
    expect(serviceTitanEndpointRecipes
      .filter((recipe) => recipe.id === "inbound-call-booking-rate")
      .map((recipe) => [recipe.version, recipe.retired === true]))
      .toEqual([[1, true], [2, true], [3, false]]);
    expect(selectableServiceTitanEndpointRecipes
      .filter((recipe) => recipe.id === "inbound-call-booking-rate")
      .map((recipe) => recipe.version))
      .toEqual([3]);
  });

  it("retires membership event v1 recipes while retaining historical lineage", () => {
    for (const id of ["new-memberships", "canceled-memberships", "membership-net-growth"]) {
      expect(serviceTitanEndpointRecipes
        .filter((recipe) => recipe.id === id)
        .map((recipe) => [recipe.version, recipe.retired === true]))
        .toEqual([[1, true], [2, false]]);
      expect(selectableServiceTitanEndpointRecipes
        .filter((recipe) => recipe.id === id)
        .map((recipe) => recipe.version))
        .toEqual([2]);
    }
  });

  it("rejects duplicate report IDs for one connection and requires numeric fields", () => {
    const connections = createSeedConnectionStore().connections;
    const existing = createSeedServiceTitanSourceStore().reports;
    const duplicate = validateServiceTitanReportSourceInput({
      connectionId: "st-sierra",
      tenantId: "sierra",
      categoryId: "operations",
      reportId: "100101",
      name: "Duplicate",
      fields: [{ name: "revenue", label: "Revenue", type: "number" }],
    }, connections, existing);
    expect(duplicate.some((issue) => issue.code === "duplicate-report")).toBe(true);

    const noNumeric = validateServiceTitanReportSourceInput({
      connectionId: "st-sierra",
      tenantId: "sierra",
      categoryId: "sales",
      reportId: "report-new",
      name: "Text only",
      fields: [{ name: "name", label: "Name", type: "string" }],
    }, connections, existing);
    expect(noNumeric.some((issue) => issue.code === "numeric-field")).toBe(true);
  });

  it("builds, upserts, persists, and defensively clones a valid saved report", () => {
    const connections = createSeedConnectionStore().connections;
    const initial = createSeedServiceTitanSourceStore();
    const result = buildServiceTitanReportSource({
      connectionId: "st-sierra",
      tenantId: "sierra",
      categoryId: "memberships",
      reportId: "membership-retention",
      owner: { id: "qa-owner", name: "QA Owner" },
      name: "Membership Retention",
      fields: [
        { name: "memberCount", label: "Member Count", type: "number" },
        { name: "cancelCount", label: "Cancel Count", type: "number" },
        { name: "period", label: "Period", type: "date" },
      ],
    }, connections, initial.reports, undefined, "2026-08-17T12:00:00.000Z");
    expect(result.issues).toEqual([]);
    expect(result.report?.schemaFingerprint).toMatch(/^schema-/);

    const store = upsertServiceTitanReportSource(initial, result.report!);
    const storage = memoryStorage();
    expect(writeServiceTitanSourceStore(storage, store)).toBe(true);
    const restored = readServiceTitanSourceStore(storage);
    expect(restored.reports.some((report) => report.reportId === "membership-retention")).toBe(true);
    restored.reports[0].fields[0].label = "Changed";
    expect(readServiceTitanSourceStore(storage).reports[0].fields[0].label).not.toBe("Changed");
    expect(storage.value(SERVICE_TITAN_SOURCE_STORAGE_KEY)).toBeTruthy();
  });

  it("fails closed when stored content is malformed or leaks secrets", () => {
    const seeded = createSeedServiceTitanSourceStore();
    expect(normalizeServiceTitanSourceStore({ schemaVersion: 1, reports: [{ ...seeded.reports[0], clientSecret: "leak" }] })).toBeNull();
    const storage = memoryStorage({ [SERVICE_TITAN_SOURCE_STORAGE_KEY]: "{broken" });
    expect(readServiceTitanSourceStore(storage)).toMatchObject({
      availability: "unavailable",
      reports: [],
    });
  });

  it("validates required report parameter types and rejects unknown parameters", () => {
    const parameters = createSeedServiceTitanSourceStore().reports[0].parameters;
    expect(validateReportParameterValues(parameters, {
      From: "2026-08-01",
      To: "2026-08-17",
      BusinessUnitIds: [101, 102],
    })).toEqual([]);
    expect(validateReportParameterValues(parameters, {
      From: "not-a-date",
      BusinessUnitIds: [],
      Unknown: true,
    })).toEqual(expect.arrayContaining([
      "Unknown report parameter Unknown.",
      "Report parameter From requires a Date value.",
      "Report parameter To is required.",
      "Report parameter BusinessUnitIds requires a non-empty Number array.",
    ]));
  });

  it("rejects passing reconciliation outside tolerance and incomplete approval evidence", () => {
    const connections = createSeedConnectionStore().connections;
    const fields = [{ name: "Revenue", label: "Revenue", type: "number" as const }];
    const outsideTolerance = {
      expectedValue: 110,
      referenceValue: 100,
      tolerance: 1,
      delta: 10,
      status: "pass" as const,
      reconciledAt: "2026-08-17T12:00:00.000Z",
      sourceFingerprint: "invalid-contract",
    };
    const rejected = buildServiceTitanReportSource({
      connectionId: "st-sierra",
      tenantId: "sierra",
      categoryId: "finance",
      reportId: "revenue-reconciliation",
      owner: { id: "qa-owner", name: "QA Owner" },
      name: "Revenue reconciliation",
      fields,
      observedFields: fields,
      lifecycle: "approved",
      sampleEvidence: { rowCount: 1, computedValue: 110, status: "pass", sampledAt: "2026-08-17T12:00:00.000Z" },
      reconciliationEvidence: outsideTolerance,
    }, connections, [], undefined, "2026-08-17T12:00:00.000Z");
    expect(rejected.report).toBeUndefined();
    expect(rejected.issues.map((issue) => issue.code)).toContain("approval-reconciliation");

    const unsafeStore = createSeedServiceTitanSourceStore();
    unsafeStore.reports[0].reconciliationEvidence = outsideTolerance;
    expect(normalizeServiceTitanSourceStore(unsafeStore)).toBeNull();
    expect(writeServiceTitanSourceStore(memoryStorage(), unsafeStore)).toBe(false);

    const incomplete = buildServiceTitanReportSource({
      connectionId: "st-sierra",
      tenantId: "sierra",
      categoryId: "finance",
      reportId: "unverified-approval",
      owner: { id: "qa-owner", name: "QA Owner" },
      name: "Unverified approval",
      fields,
      observedFields: [{ name: "Different", label: "Different", type: "number" }],
      lifecycle: "approved",
    }, connections, [], undefined, "2026-08-17T12:00:00.000Z");
    expect(incomplete.report).toBeUndefined();
    expect(incomplete.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "approval-schema",
      "approval-sample",
      "approval-reconciliation",
    ]));
  });

  it("seeds an absent source store and fails closed for unsafe v2 data and failed writes", () => {
    const emptyStorage = memoryStorage();
    const seeded = readServiceTitanSourceStore(emptyStorage);
    expect(seeded).toMatchObject({ schemaVersion: 3, availability: "available" });
    expect(seeded.reports).toHaveLength(3);
    expect(JSON.parse(emptyStorage.value(SERVICE_TITAN_SOURCE_STORAGE_KEY)!)).toMatchObject({ schemaVersion: 3 });

    const unsafe = createSeedServiceTitanSourceStore() as typeof seeded & { clientSecret?: string };
    unsafe.clientSecret = "must-not-persist";
    const unsafeStorage = memoryStorage({ [SERVICE_TITAN_SOURCE_STORAGE_KEY]: JSON.stringify(unsafe) });
    expect(readServiceTitanSourceStore(unsafeStorage)).toMatchObject({ availability: "unavailable", reports: [] });
    expect(writeServiceTitanSourceStore(memoryStorage(), unsafe)).toBe(false);
    expect(writeServiceTitanSourceStore({ setItem() { throw new Error("quota"); } }, seeded)).toBe(false);
  });
});
