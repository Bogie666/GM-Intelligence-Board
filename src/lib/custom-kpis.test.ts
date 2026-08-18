import { describe, expect, it } from "vitest";
import { getMetrics, locations } from "./demo-data";
import { createSeedConnectionStore } from "./demo-connections";
import { createSeedServiceTitanSourceStore } from "./service-titan-sources";
import {
  CUSTOM_KPI_STORAGE_KEY,
  V2_CUSTOM_KPI_STORAGE_KEY,
  createCustomKpiDraft,
  duplicateCustomKpiDefinition,
  evaluateCustomKpis,
  normalizeCustomKpiStore,
  readCustomKpiStore,
  runCustomKpiValidation,
  serviceTitanObservationFingerprint,
  slugifyKpiKey,
  writeCustomKpiStore,
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

function validServiceTitanDraft(overrides: Partial<CustomKpiDefinition> = {}): CustomKpiDefinition {
  const connections = createSeedConnectionStore().connections;
  return validDraft({
    type: "service-titan",
    leftMetricId: undefined,
    rightMetricId: undefined,
    operation: undefined,
    manualValue: undefined,
    asOf: undefined,
    kind: "currency",
    serviceTitanSource: {
      method: "endpoint-recipe",
      refreshInterval: "1h",
      endpointRecipeId: "completed-revenue",
      endpointRecipeVersion: 1,
      tenantBindings: locations.map((location) => ({
        tenantId: location.tenantId,
        connectionId: connections.find((connection) => connection.tenantId === location.tenantId)!.id,
        timezone: location.timezone,
        locationIds: [location.id],
        prototypeValue: 1000,
        prototypePriorValue: 900,
        prototypeAsOf: "2026-08-17",
      })),
    },
    ...overrides,
  });
}

function materializedEndpointDraft(asOf = "2026-08-17T00:00:00.000Z"): CustomKpiDefinition {
  const definition = validServiceTitanDraft({
    scopeMode: "selected-locations",
    locationIds: ["sierra-abq"],
    serviceTitanSource: {
      method: "endpoint-recipe",
      refreshInterval: "1h",
      endpointRecipeId: "completed-revenue",
      endpointRecipeVersion: 1,
      tenantBindings: [{
        tenantId: "sierra",
        connectionId: "st-sierra",
        timezone: "America/Denver",
        locationIds: ["sierra-abq"],
      }],
    },
  });
  const source = definition.serviceTitanSource!;
  const binding = source.tenantBindings[0];
  binding.observation = {
    value: 1234,
    prior: 1200,
    asOf,
    sourceFingerprint: serviceTitanObservationFingerprint(source, binding)!,
    sourceVersion: 1,
    status: "valid",
  };
  return definition;
}

function validSavedReportDraft(): CustomKpiDefinition {
  const report = createSeedServiceTitanSourceStore().reports.find((item) => item.tenantId === "sierra")!;
  return validServiceTitanDraft({
    kind: "number",
    scopeMode: "selected-locations",
    locationIds: ["sierra-abq"],
    serviceTitanSource: {
      method: "saved-report",
      refreshInterval: "12h",
      reportReduction: "sum",
      tenantBindings: [{
        tenantId: "sierra",
        connectionId: "st-sierra",
        timezone: "America/Denver",
        locationIds: ["sierra-abq"],
        reportSourceId: report.id,
        expectedSchemaFingerprint: report.expectedSchemaFingerprint,
        parameterValues: { From: "2026-08-01", To: "2026-08-17", BusinessUnitIds: [101] },
        businessUnitMappings: { "sierra-abq": ["101"] },
        approvalStatus: "approved",
        valueField: "BookedCalls",
        prototypeValue: 70,
        prototypePriorValue: 68,
        prototypeAsOf: "2026-08-17T00:00:00.000Z",
      }],
    },
  });
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

  it("validates tenant-specific endpoint mappings and evaluates only the selected tenant snapshot", () => {
    const definition = validServiceTitanDraft();
    definition.serviceTitanSource!.tenantBindings[1].prototypeValue = 2200;
    const context = {
      locations,
      connections: createSeedConnectionStore().connections,
      serviceTitanReports: createSeedServiceTitanSourceStore().reports,
      tenantId: "asi",
      locationId: "asi-san-diego",
      now: "2026-08-17T00:30:00.000Z",
    };
    const validation = runCustomKpiValidation(definition, catalog, [], context);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const result = evaluateCustomKpis([definition], catalog, context).get(definition.id);
    expect(result).toMatchObject({ state: "available", value: 2200, source: "ServiceTitan" });
    expect(result?.lineage.join(" ")).toContain("completed-revenue@v1");
  });

  it("blocks saved reports from endpoint-only refresh frequencies", () => {
    const reports = createSeedServiceTitanSourceStore().reports;
    const connections = createSeedConnectionStore().connections;
    const definition = validServiceTitanDraft({
      kind: "currency",
      serviceTitanSource: {
        method: "saved-report",
        refreshInterval: "15m",
        reportReduction: "sum",
        tenantBindings: locations.map((location) => {
          const connection = connections.find((item) => item.tenantId === location.tenantId)!;
          const report = reports.find((item) => item.tenantId === location.tenantId)!;
          return {
            tenantId: location.tenantId,
            connectionId: connection.id,
            timezone: location.timezone,
            locationIds: [location.id],
            reportSourceId: report.id,
            reportSchemaFingerprint: report.schemaFingerprint,
            valueField: report.fields.find((field) => field.type === "number")!.name,
            prototypeValue: 100,
            prototypeAsOf: "2026-08-17",
          };
        }),
      },
    });
    const validation = runCustomKpiValidation(definition, catalog, [], { locations, connections, serviceTitanReports: reports });
    expect(validation.issues.some((issue) => issue.code === "st-cadence" && issue.severity === "error")).toBe(true);
  });

  it("blocks saved-report schema drift and missing numeric field mappings", () => {
    const reports = createSeedServiceTitanSourceStore().reports;
    const connections = createSeedConnectionStore().connections;
    const report = reports.find((item) => item.tenantId === "sierra")!;
    const definition = validServiceTitanDraft({
      scopeMode: "selected-locations",
      locationIds: ["sierra-abq"],
      serviceTitanSource: {
        method: "saved-report",
        refreshInterval: "12h",
        reportReduction: "sum",
        tenantBindings: [{
          tenantId: "sierra",
          connectionId: "st-sierra",
          timezone: "America/Denver",
          locationIds: ["sierra-abq"],
          reportSourceId: report.id,
          reportSchemaFingerprint: "stale-fingerprint",
          prototypeValue: 100,
          prototypeAsOf: "2026-08-17",
        }],
      },
    });
    const validation = runCustomKpiValidation(definition, catalog, [], { locations, connections, serviceTitanReports: reports });
    expect(validation.issues.some((issue) => issue.code === "st-report-schema-sierra")).toBe(true);
    expect(validation.issues.some((issue) => issue.code === "st-value-field-sierra")).toBe(true);
  });

  it("duplicates ServiceTitan bindings deeply so destructive edits remain isolated", () => {
    const original = validServiceTitanDraft({ id: "st-original" });
    const duplicate = duplicateCustomKpiDefinition(original, "st-copy", "2026-08-17T14:00:00.000Z");
    duplicate.serviceTitanSource!.tenantBindings[0].connectionId = "changed";
    expect(original.serviceTitanSource!.tenantBindings[0].connectionId).toBe("st-sierra");
    expect(duplicate.serviceTitanSource).not.toBe(original.serviceTitanSource);
    expect(duplicate.serviceTitanSource!.tenantBindings).not.toBe(original.serviceTitanSource!.tenantBindings);
  });

  it("fails closed without one exact runtime tenant/location binding", () => {
    const definition = materializedEndpointDraft();
    const baseContext = {
      locations,
      connections: createSeedConnectionStore().connections,
      now: "2026-08-17T01:00:00.000Z",
    };

    expect(evaluateCustomKpis([definition], catalog, baseContext).get(definition.id)).toMatchObject({
      state: "unavailable",
      reason: "ServiceTitan evaluation requires an exact tenant and location context.",
    });
    expect(evaluateCustomKpis([definition], catalog, {
      ...baseContext,
      tenantId: "asi",
      locationId: "sierra-abq",
    }).get(definition.id)?.reason).toContain("does not belong");

    definition.serviceTitanSource!.tenantBindings.push({
      ...definition.serviceTitanSource!.tenantBindings[0],
      locationIds: ["sierra-abq"],
    });
    const duplicateContext = { ...baseContext, tenantId: "sierra", locationId: "sierra-abq" };
    expect(evaluateCustomKpis([definition], catalog, duplicateContext).get(definition.id)?.reason).toContain("Multiple ServiceTitan bindings");
    expect(runCustomKpiValidation(definition, catalog, [], { ...duplicateContext, locations }).issues
      .some((issue) => issue.code === "st-duplicate-location")).toBe(true);
  });

  it("rejects archived or mismatched connections and missing recipe capability", () => {
    const definition = materializedEndpointDraft();
    const baseConnections = createSeedConnectionStore().connections;
    const context = {
      locations,
      tenantId: "sierra",
      locationId: "sierra-abq",
      now: "2026-08-17T01:00:00.000Z",
    };
    const cases = [
      {
        connections: baseConnections.map((item) => item.id === "st-sierra" ? { ...item, status: "archived" as const } : item),
        reason: "not ready",
      },
      {
        connections: baseConnections.map((item) => item.id === "st-sierra" ? { ...item, tenantId: "asi" } : item),
        reason: "tenant-matched",
      },
      {
        connections: baseConnections.map((item) => item.id === "st-sierra" ? { ...item, capabilities: item.capabilities.filter((capability) => capability !== "jobs") } : item),
        reason: "lacks the jobs capability",
      },
    ];
    for (const item of cases) {
      const result = evaluateCustomKpis([definition], catalog, { ...context, connections: item.connections }).get(definition.id);
      expect(result?.state).toBe("unavailable");
      expect(result?.reason).toContain(item.reason);
    }
  });

  it("enforces deterministic observation freshness, fingerprint, and version gates", () => {
    const context = {
      locations,
      connections: createSeedConnectionStore().connections,
      tenantId: "sierra",
      locationId: "sierra-abq",
      now: "2026-08-17T06:00:00.000Z",
    };
    const stale = materializedEndpointDraft("2026-08-17T00:00:00.000Z");
    const staleResult = evaluateCustomKpis([stale], catalog, context).get(stale.id);
    expect(staleResult).toMatchObject({ state: "unavailable", reason: expect.stringContaining("stale") });
    expect(staleResult?.lastValidObservation).toEqual(stale.serviceTitanSource!.tenantBindings[0].observation);

    const future = materializedEndpointDraft("2026-08-17T07:00:00.000Z");
    const futureResult = evaluateCustomKpis([future], catalog, context).get(future.id);
    expect(futureResult).toMatchObject({ state: "unavailable", reason: expect.stringContaining("future") });
    expect(futureResult?.lastValidObservation).toBeUndefined();

    for (const mutation of ["fingerprint", "version"] as const) {
      const definition = materializedEndpointDraft("2026-08-17T05:00:00.000Z");
      const observation = definition.serviceTitanSource!.tenantBindings[0].observation!;
      if (mutation === "fingerprint") observation.sourceFingerprint = "st-contract-wrong";
      else observation.sourceVersion += 1;
      const result = evaluateCustomKpis([definition], catalog, context).get(definition.id);
      expect(result).toMatchObject({ state: "unavailable", reason: expect.stringContaining("fingerprint or version") });
      expect(result?.lastValidObservation).toBeUndefined();
    }
  });

  it("fingerprints every governed tenant, location, source, parameter, mapping, reduction, and field input", () => {
    const definition = validSavedReportDraft();
    const source = definition.serviceTitanSource!;
    const binding = source.tenantBindings[0];
    const report = createSeedServiceTitanSourceStore().reports.find((item) => item.id === binding.reportSourceId)!;
    const baseline = serviceTitanObservationFingerprint(source, binding, report);
    expect(baseline).toMatch(/^st-contract-/);

    const changedFingerprints = [
      serviceTitanObservationFingerprint(source, { ...binding, tenantId: "tenant-changed" }, report),
      serviceTitanObservationFingerprint(source, { ...binding, locationIds: ["location-changed"] }, report),
      serviceTitanObservationFingerprint(source, { ...binding, connectionId: "connection-changed" }, report),
      serviceTitanObservationFingerprint(source, binding, { ...report, reportId: "report-changed" }),
      serviceTitanObservationFingerprint(source, { ...binding, parameterValues: { ...binding.parameterValues, To: "2026-08-18" } }, report),
      serviceTitanObservationFingerprint(source, { ...binding, businessUnitMappings: { "sierra-abq": ["202"] } }, report),
      serviceTitanObservationFingerprint({ ...source, reportReduction: "average" }, binding, report),
      serviceTitanObservationFingerprint(source, { ...binding, valueField: "EligibleCalls" }, report),
    ];
    for (const changed of changedFingerprints) expect(changed).not.toBe(baseline);

    const endpoint = materializedEndpointDraft();
    const endpointSource = endpoint.serviceTitanSource!;
    const endpointBinding = endpointSource.tenantBindings[0];
    expect(serviceTitanObservationFingerprint({ ...endpointSource, endpointRecipeVersion: 2 }, endpointBinding))
      .not.toBe(serviceTitanObservationFingerprint(endpointSource, endpointBinding));
  });

  it("rejects invalid saved-report parameters and business-unit mapping mismatches", () => {
    const definition = validSavedReportDraft();
    const binding = definition.serviceTitanSource!.tenantBindings[0];
    const context = {
      locations,
      connections: createSeedConnectionStore().connections,
      serviceTitanReports: createSeedServiceTitanSourceStore().reports,
      now: "2026-08-17T01:00:00.000Z",
    };
    binding.parameterValues = { ...binding.parameterValues, From: "08/01/2026" };
    expect(runCustomKpiValidation(definition, catalog, [], context).issues
      .some((issue) => issue.code.startsWith("st-report-parameter-sierra"))).toBe(true);

    binding.parameterValues = { From: "2026-08-01", To: "2026-08-17", BusinessUnitIds: [202] };
    expect(runCustomKpiValidation(definition, catalog, [], context).issues
      .some((issue) => issue.code === "st-business-unit-parameter-sierra")).toBe(true);
    expect(evaluateCustomKpis([definition], catalog, {
      ...context,
      tenantId: "sierra",
      locationId: "sierra-abq",
    }).get(definition.id)?.reason).toContain("exactly the mapped business units");
  });

  it("rejects a saved-report ratio that maps the same field twice", () => {
    const definition = validSavedReportDraft();
    definition.serviceTitanSource!.reportReduction = "ratio";
    const binding = definition.serviceTitanSource!.tenantBindings[0];
    binding.numeratorField = "BookedCalls";
    binding.denominatorField = "BookedCalls";
    const validation = runCustomKpiValidation(definition, catalog, [], {
      locations,
      connections: createSeedConnectionStore().connections,
      serviceTitanReports: createSeedServiceTitanSourceStore().reports,
      now: "2026-08-17T01:00:00.000Z",
    });
    expect(validation.issues.some((issue) => issue.code === "st-ratio-fields-sierra")).toBe(true);
  });

  it("fails closed for unsafe, malformed, or duplicate-bound custom stores and failed writes", () => {
    const validStore = { schemaVersion: 3 as const, definitions: [validDraft()] };
    const unsafe = JSON.parse(JSON.stringify(validStore));
    unsafe.definitions[0].clientSecret = "must-not-persist";
    expect(normalizeCustomKpiStore(unsafe)).toMatchObject({ availability: "unavailable", definitions: [] });

    const malformed = JSON.parse(JSON.stringify(validStore));
    malformed.definitions[0].kind = "money";
    expect(normalizeCustomKpiStore(malformed)).toMatchObject({ availability: "unavailable", definitions: [] });

    const duplicateBound = { schemaVersion: 3 as const, definitions: [materializedEndpointDraft()] };
    duplicateBound.definitions[0].serviceTitanSource!.tenantBindings.push({
      ...duplicateBound.definitions[0].serviceTitanSource!.tenantBindings[0],
    });
    expect(normalizeCustomKpiStore(duplicateBound)).toMatchObject({ availability: "unavailable", definitions: [] });
    expect(writeCustomKpiStore(memoryStorage(), duplicateBound)).toBe(false);
    expect(writeCustomKpiStore({ setItem() { throw new Error("quota"); } }, validStore)).toBe(false);
  });

  it("migrates the actual v2 storage key and rewrites a normalized v3 store", () => {
    const storage = memoryStorage({
      [V2_CUSTOM_KPI_STORAGE_KEY]: JSON.stringify({ schemaVersion: 2, definitions: [validDraft()] }),
    });
    const migrated = readCustomKpiStore(storage, now);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.definitions).toHaveLength(1);
    expect(JSON.parse(storage.value(CUSTOM_KPI_STORAGE_KEY)!)).toMatchObject({
      schemaVersion: 3,
      definitions: [{ id: "custom-test" }],
    });
  });

  it("migrates valid v1 metrics once and preserves manual lineage", () => {
    const storage = memoryStorage({
      "gmib.custom-metrics.v1": JSON.stringify([{ id: "legacy-1", title: "Legacy Reviews", section: "executive", source: "GA4", actual: 42, goal: 50, kind: "number", subtitle: "Old form" }]),
    });
    const store = readCustomKpiStore(storage, now);
    expect(store.schemaVersion).toBe(3);
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
