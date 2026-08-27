import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  origin: "https://admin.example.com",
  host: "admin.example.com",
  role: "admin",
  authOk: true,
  rpc: vi.fn(),
  serviceRole: vi.fn(),
  inspectCustom: vi.fn(),
  inspectDomo: vi.fn(),
  validateDomo: vi.fn(),
  govern: vi.fn(),
  revalidate: vi.fn(),
  fixtures: new Map<string, unknown>(),
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: mocks.origin, host: mocks.host }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/env", () => ({ getAppConfig: () => ({ isDemo: false }) }));
vi.mock("@/lib/auth", () => ({
  isAdminRole: (role: string) => role === "admin" || role === "owner",
  getTenantAuthContext: async () => mocks.authOk ? {
    ok: true,
    membership: { organizationId: IDS.organization, role: mocks.role },
    user: { id: IDS.profile },
    supabase: fakeSupabase,
  } : { ok: false },
}));
vi.mock("@/lib/service-titan-sources", () => ({
  reportSchemaFingerprint: () => "sha256:test",
  selectableServiceTitanEndpointRecipes: [
    { id: "completed-jobs-count", version: 1 },
    { id: "inbound-call-booking-rate", version: 3 },
  ],
}));
vi.mock("@/lib/custom-endpoint-sources", () => ({
  validateCustomEndpointSourceInput: (value: Record<string, string>) => {
    try {
      return { ok: true, value: { name: value.name.trim(), description: value.description.trim(), category: value.category, queryParameters: JSON.parse(value.queryParameters || "{}"), reduction: value.reduction, valueField: value.reduction === "count" ? null : value.valueField, businessUnitField: value.businessUnitField || null } };
    } catch { return { ok: false, fieldErrors: { queryParameters: "Invalid JSON" } }; }
  },
}));
vi.mock("@/lib/domo-admin", () => ({
  validateCompletedPeriod: ({ periodStart, periodEnd }: Record<string, string>) => ({ ok: true, value: { periodStart, periodEnd } }),
  validateBoundedDecimal: (value: string) => ({ ok: true, value }),
  validateDomoRefreshCadence: (value: string) => ["4h", "12h", "24h"].includes(value),
  validateDomoConnectionInput: (value: Record<string, string>) => ({ ok: true, value }),
  validateDomoDatasetSourceInput: (value: Record<string, string>) => ({ ok: true, value: { ...value, description: value.description || "", valueColumn: value.valueColumn || null, dateColumn: value.dateColumn || null, filterColumn: value.filterColumn || null, filterValue: value.filterValue || null } }),
}));
vi.mock("@/lib/production-admin-settings", () => ({
  reportSchemaFingerprint: () => "sha256:test",
  isIsoDate: () => true,
  isValidMetricKey: () => true,
  parseFiniteConfigurationNumber: (value: string) => Number(value),
  parseConfigurationJson: (raw: string) => { try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false, message: "Invalid JSON" }; } },
  validateEndpointRecipeBindingConfiguration: () => ({ ok: true }),
}));
vi.mock("@/lib/tenant-context", () => ({ validateUuid: (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleSupabaseClient: mocks.serviceRole }));
vi.mock("@/lib/data-source-workers", () => ({
  inspectCustomEndpointSource: mocks.inspectCustom,
  inspectDomoDatasetSource: mocks.inspectDomo,
  validateDomoConnection: mocks.validateDomo,
  governDataSourceBinding: mocks.govern,
}));

const IDS = {
  organization: "11111111-1111-4111-8111-111111111111",
  profile: "22222222-2222-4222-8222-222222222222",
  definition: "33333333-3333-4333-8333-333333333333",
  location: "44444444-4444-4444-8444-444444444444",
  connection: "55555555-5555-4555-8555-555555555555",
  source: "66666666-6666-4666-8666-666666666666",
  binding: "77777777-7777-4777-8777-777777777777",
};

function query(table: string) {
  const builder = {
    select: vi.fn(() => builder), eq: vi.fn(() => builder), neq: vi.fn(() => builder), is: vi.fn(() => builder),
    in: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(() => builder),
    update: vi.fn((row: Record<string, unknown>) => { mocks.upserts.push({ table, row }); return builder; }),
    insert: vi.fn(async (row: Record<string, unknown>) => {
      mocks.upserts.push({ table, row }); return { data: null, error: null };
    }),
    upsert: vi.fn(async (row: Record<string, unknown>) => {
      mocks.upserts.push({ table, row }); return { data: null, error: null };
    }),
    maybeSingle: vi.fn(async () => ({ data: mocks.fixtures.get(table) ?? null, error: null })),
  };
  return builder;
}
const fakeSupabase = { rpc: (...args: unknown[]) => mocks.rpc(...args), from: (table: string) => query(table) };

import {
  archiveCustomEndpointSourceAction,
  archiveDomoDatasetSourceAction,
  createCustomEndpointSourceAction,
  disableDomoConnectionAction,
  governCustomEndpointBindingAction,
  governDomoDatasetBindingAction,
  inspectCustomEndpointSourceAction,
  registerDomoConnectionAction,
  saveKpiBindingAction,
  validateDomoConnectionAction,
} from "./settings-actions";

const INITIAL = { status: "idle" as const, message: "" };
function form(values: Record<string, string>) {
  const data = new FormData();
  Object.entries(values).forEach(([key, value]) => data.set(key, value));
  return data;
}

function baseBinding(method: string) {
  return form({
    kpiDefinitionId: IDS.definition, locationId: IDS.location, sourceMethod: method,
    refreshInterval: method === "endpoint_recipe" ? "1h" : method === "domo_dataset" ? "24h" : "4h",
    parameterValues: "{}", businessUnitMappings: "{}", connectionId: IDS.connection,
  });
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.origin = "https://admin.example.com"; mocks.host = "admin.example.com";
  mocks.role = "admin"; mocks.authOk = true; mocks.fixtures.clear(); mocks.upserts.length = 0;
  mocks.serviceRole.mockReturnValue({ trusted: true });
  mocks.rpc.mockResolvedValue({ data: IDS.source, error: null });
  mocks.inspectCustom.mockResolvedValue({ rowCount: 2, pageCount: 1 });
  mocks.validateDomo.mockResolvedValue({ ok: true });
  mocks.govern.mockResolvedValue({ approved: true, rowCount: 2 });
});

describe("data-source administration actions", () => {
  it("rejects an invalid origin before creating a service-role client", async () => {
    mocks.origin = "https://evil.example";
    const result = await validateDomoConnectionAction(INITIAL, form({ connectionId: IDS.connection }));
    expect(result.status).toBe("error");
    expect(mocks.serviceRole).not.toHaveBeenCalled();
  });

  it("rejects viewer access before creating a service-role client", async () => {
    mocks.role = "viewer";
    const result = await inspectCustomEndpointSourceAction(INITIAL, form({ sourceId: IDS.source, periodStart: "2024-01-01T00:00:00.000Z", periodEnd: "2024-01-02T00:00:00.000Z" }));
    expect(result.status).toBe("error");
    expect(mocks.serviceRole).not.toHaveBeenCalled();
    expect(mocks.inspectCustom).not.toHaveBeenCalled();
  });

  it("revalidates the Admin Center after failed Domo validation so persisted failure state is visible", async () => {
    mocks.validateDomo.mockRejectedValueOnce(new Error("provider failure"));
    const result = await validateDomoConnectionAction(INITIAL, form({ connectionId: IDS.connection }));
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("provider failure");
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("passes a custom endpoint declaration through the exact tenant RPC", async () => {
    const result = await createCustomEndpointSourceAction(INITIAL, form({
      connectionId: IDS.connection, serviceTitanTenantId: "tenant-1", name: "Completed jobs", description: "Governed",
      category: "jobs", queryParameters: '{"status":"Completed"}', reduction: "count", valueField: "", businessUnitField: "businessUnit.id",
    }));
    expect(result.status).toBe("success");
    expect(mocks.rpc).toHaveBeenCalledWith("create_service_titan_custom_endpoint_source", {
      p_organization_id: IDS.organization, p_connection_id: IDS.connection, p_service_titan_tenant_id: "tenant-1",
      p_name: "Completed jobs", p_description: "Governed", p_category: "jobs", p_query_parameters: { status: "Completed" },
      p_reduction: "count", p_value_field: null, p_business_unit_field: "businessUnit.id",
    });
  });

  it("never returns Domo credentials even when registration fails", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "provider leaked secret" } });
    const result = await registerDomoConnectionAction(INITIAL, form({ displayName: "Finance", clientId: "client-id-123", clientSecret: "top-secret-123" }));
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("top-secret-123");
    expect(result.message).not.toContain("provider leaked");
  });

  it("passes compare-and-swap dependency counts to destructive RPCs", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    expect((await archiveCustomEndpointSourceAction(INITIAL, form({ sourceId: IDS.source, expectedDependentBindings: "2" }))).status).toBe("success");
    expect(mocks.rpc).toHaveBeenLastCalledWith("archive_service_titan_custom_endpoint_source", {
      p_organization_id: IDS.organization, p_source_id: IDS.source, p_expected_dependent_bindings: 2,
    });
    expect((await archiveDomoDatasetSourceAction(INITIAL, form({ sourceId: IDS.source, expectedDependentBindings: "3" }))).status).toBe("success");
    expect(mocks.rpc).toHaveBeenLastCalledWith("archive_domo_dataset_source", {
      p_organization_id: IDS.organization, p_source_id: IDS.source, p_expected_dependent_bindings: 3,
    });
    expect((await disableDomoConnectionAction(INITIAL, form({ connectionId: IDS.connection, expectedDependentSources: "4", expectedDependentBindings: "5" }))).status).toBe("success");
    expect(mocks.rpc).toHaveBeenLastCalledWith("disable_domo_connection", {
      p_organization_id: IDS.organization, p_connection_id: IDS.connection,
      p_expected_dependent_sources: 4, p_expected_dependent_bindings: 5,
    });
  });

  it("rejects missing impact data and treats interrupted destructive responses as outcome-unknown", async () => {
    const incomplete = await archiveCustomEndpointSourceAction(INITIAL, form({ sourceId: IDS.source }));
    expect(incomplete.status).toBe("error");
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockRejectedValueOnce(new Error("network interrupted"));
    const interrupted = await archiveDomoDatasetSourceAction(INITIAL, form({ sourceId: IDS.source, expectedDependentBindings: "0" }));
    expect(interrupted.status).toBe("error");
    expect(interrupted.message).toContain("Reload");
    expect(interrupted.message).not.toContain("network interrupted");
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it.each([
    ["custom_endpoint", governCustomEndpointBindingAction],
    ["domo_dataset", governDomoDatasetBindingAction],
  ] as const)("fixes governance method and actor server-side for %s", async (method, action) => {
    const result = await action(INITIAL, form({ bindingId: IDS.binding, actorProfileId: "attacker", periodStart: "2024-01-01T00:00:00.000Z", periodEnd: "2024-01-02T00:00:00.000Z", referenceValue: "12.5", tolerance: "0.5" }));
    expect(result.status).toBe("success");
    expect(mocks.govern).toHaveBeenCalledWith({ trusted: true }, expect.objectContaining({ organizationId: IDS.organization, bindingId: IDS.binding, actorProfileId: IDS.profile }), method);
  });
});

describe("four governed binding methods", () => {
  beforeEach(() => {
    mocks.fixtures.set("locations", { id: IDS.location });
    mocks.fixtures.set("service_titan_connection_locations", { id: "assignment" });
    mocks.fixtures.set("service_titan_connections", { id: IDS.connection, service_titan_tenant_id: "tenant-1" });
  });

  it.each([
    ["endpoint_recipe", { endpoint_recipe_id: "completed-jobs-count", endpoint_recipe_version: 1 }],
    ["saved_report", { report_source_id: IDS.source, report_reduction: "sum", value_field: "Total" }],
    ["custom_endpoint", { custom_endpoint_source_id: IDS.source }],
  ] as const)("saves %s with every other source family cleared", async (method, expected) => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    if (method === "endpoint_recipe") mocks.fixtures.set("service_titan_endpoint_recipe_refresh_policies", { endpoint_recipe_id: "completed-jobs-count" });
    if (method === "saved_report") mocks.fixtures.set("service_titan_report_sources", { id: IDS.source, fields: [{ name: "Total", type: "number" }], parameters: [] });
    if (method === "custom_endpoint") mocks.fixtures.set("service_titan_custom_endpoint_sources", { id: IDS.source });
    const data = baseBinding(method);
    if (method === "endpoint_recipe") { data.set("endpointRecipeId", "completed-jobs-count"); data.set("endpointRecipeVersion", "1"); }
    if (method === "saved_report") { data.set("reportSourceId", IDS.source); data.set("reportReduction", "sum"); data.set("valueField", "Total"); }
    if (method === "custom_endpoint") data.set("customEndpointSourceId", IDS.source);
    const result = await saveKpiBindingAction(INITIAL, data);
    expect(result.status).toBe("success");
    const row = mocks.upserts.at(-1)?.row;
    expect(row).toMatchObject({ source_method: method, approval_status: "draft", approved_by: null, approved_at: null, ...expected });
    const selected = new Set(Object.keys(expected));
    for (const key of ["endpoint_recipe_id", "endpoint_recipe_version", "report_source_id", "custom_endpoint_source_id", "domo_connection_id", "domo_dataset_source_id"]) {
      if (!selected.has(key)) expect(row?.[key]).toBeNull();
    }
  });

  it("rejects retired inbound booking-rate recipe versions even when a crafted request bypasses the UI", async () => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    const data = baseBinding("endpoint_recipe");
    data.set("endpointRecipeId", "inbound-call-booking-rate");
    data.set("endpointRecipeVersion", "2");
    const result = await saveKpiBindingAction(INITIAL, data);
    expect(result.status).toBe("error");
    expect(result.message).toContain("retired");
    expect(mocks.upserts).toHaveLength(0);
  });

  it("saves an exact Domo binding without any ServiceTitan assignment or stale source columns", async () => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "external", external_source: { provider: "domo" } });
    mocks.fixtures.set("domo_connections", { id: IDS.connection });
    mocks.fixtures.set("domo_dataset_sources", { id: IDS.source });
    const data = baseBinding("domo_dataset"); data.set("domoConnectionId", IDS.connection); data.set("domoDatasetSourceId", IDS.source);
    const result = await saveKpiBindingAction(INITIAL, data);
    expect(result.status).toBe("success");
    const row = mocks.upserts.at(-1)?.row;
    expect(row).toMatchObject({ source_method: "domo_dataset", connection_id: null, service_titan_tenant_id: null, domo_connection_id: IDS.connection, domo_dataset_source_id: IDS.source, report_source_id: null, custom_endpoint_source_id: null, endpoint_recipe_id: null });
  });

  it("fails closed when the exact tenant source is unavailable", async () => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    const data = baseBinding("custom_endpoint"); data.set("customEndpointSourceId", IDS.source);
    const result = await saveKpiBindingAction(INITIAL, data);
    expect(result.status).toBe("error");
    expect(mocks.upserts).toHaveLength(0);
  });

  it.each(["approved", "archived"])("refuses to replace an immutable %s binding", async (approvalStatus) => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    mocks.fixtures.set("custom_kpi_location_bindings", { id: IDS.binding, approval_status: approvalStatus });
    const data = baseBinding("custom_endpoint");
    data.set("customEndpointSourceId", IDS.source);
    data.set("confirmReplacement", "replace");
    const result = await saveKpiBindingAction(INITIAL, data);
    expect(result.status).toBe("error");
    expect(result.message).toContain("immutable");
    expect(mocks.upserts).toHaveLength(0);
  });

  it("stamps the requested observation window on the draft and defaults to trailing", async () => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    mocks.fixtures.set("service_titan_custom_endpoint_sources", { id: IDS.source });
    const data = baseBinding("custom_endpoint"); data.set("customEndpointSourceId", IDS.source);
    const defaulted = await saveKpiBindingAction(INITIAL, data);
    expect(defaulted.status).toBe("success");
    expect(mocks.upserts.at(-1)?.row).toMatchObject({ observation_window: "trailing" });
    data.set("observationWindow", "mtd");
    const monthly = await saveKpiBindingAction(INITIAL, data);
    expect(monthly.status).toBe("success");
    expect(mocks.upserts.at(-1)?.row).toMatchObject({ observation_window: "mtd" });
  });

  it("rejects unsupported observation windows before touching the database", async () => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    mocks.fixtures.set("service_titan_custom_endpoint_sources", { id: IDS.source });
    const data = baseBinding("custom_endpoint"); data.set("customEndpointSourceId", IDS.source);
    data.set("observationWindow", "yearly");
    const result = await saveKpiBindingAction(INITIAL, data);
    expect(result.status).toBe("error");
    expect(result.message).toContain("observation window");
    expect(mocks.upserts).toHaveLength(0);
  });

  it("requires explicit confirmation before replacing an existing draft binding", async () => {
    mocks.fixtures.set("custom_kpi_definitions", { id: IDS.definition, type: "service_titan", external_source: null });
    mocks.fixtures.set("custom_kpi_location_bindings", { id: IDS.binding, approval_status: "draft" });
    mocks.fixtures.set("service_titan_custom_endpoint_sources", { id: IDS.source });
    const data = baseBinding("custom_endpoint"); data.set("customEndpointSourceId", IDS.source);
    const rejected = await saveKpiBindingAction(INITIAL, data);
    expect(rejected.status).toBe("error");
    expect(rejected.fieldErrors?.confirmReplacement).toBeDefined();
    expect(mocks.upserts).toHaveLength(0);
    data.set("confirmReplacement", "replace");
    const accepted = await saveKpiBindingAction(INITIAL, data);
    expect(accepted.status).toBe("success");
    expect(mocks.upserts).toHaveLength(1);
  });
});
