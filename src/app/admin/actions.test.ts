import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  revalidatePath: vi.fn(),
  getTenantAuthContext: vi.fn(),
  getAppConfig: vi.fn(),
  createServiceRoleSupabaseClient: vi.fn(),
  executeValidation: vi.fn(),
  executeDiscovery: vi.fn(),
  validateLocationInput: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({
  getTenantAuthContext: mocks.getTenantAuthContext,
  isAdminRole: (role: unknown) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/env", () => ({ getAppConfig: mocks.getAppConfig }));
vi.mock("@/lib/tenant-context", () => ({
  validateBusinessUnitMappingInput: (input: Record<string, unknown>) => {
    const locationId = typeof input.locationId === "string" ? input.locationId.trim() : "";
    const providerBusinessUnitId = typeof input.providerBusinessUnitId === "string" ? input.providerBusinessUnitId : "";
    const divisionId = typeof input.divisionId === "string" ? input.divisionId.trim() : "";
    return /^[0-9a-f-]{36}$/i.test(locationId) && /^[0-9a-f-]{36}$/i.test(divisionId) && providerBusinessUnitId === providerBusinessUnitId.trim() && providerBusinessUnitId.length > 0
      ? { ok: true, value: { locationId, providerBusinessUnitId, divisionId } }
      : { ok: false, fieldErrors: { mapping: "invalid" } };
  },
  validateConnectionCredentialInput: vi.fn(),
  validateCredentialRotationInput: vi.fn(),
  validateDivisionInput: (input: Record<string, unknown>) => {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    return name && name.length <= 80 && !["not mapped", "unmapped"].includes(name.toLowerCase())
      ? { ok: true, value: { name } }
      : { ok: false, fieldErrors: { name: "invalid" } };
  },
  validateLocationInput: mocks.validateLocationInput,
  validateOrganizationInput: vi.fn(),
  validateUuid: (value: unknown) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value),
}));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleSupabaseClient: mocks.createServiceRoleSupabaseClient,
}));
vi.mock("@/lib/servicetitan-workers", () => ({
  executeServiceTitanValidation: mocks.executeValidation,
  executeServiceTitanBusinessUnitDiscovery: mocks.executeDiscovery,
}));

import {
  createDivisionAction,
  createLocationAction,
  replaceBusinessUnitMappingsAction,
  runBusinessUnitDiscoveryAction,
  setDivisionStatusAction,
  updateLocationAction,
  validateServiceTitanConnectionAction,
} from "./actions";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000002";
const DISCOVERY_RUN_ID = "30000000-0000-4000-8000-000000000003";
const LOCATION_ID = "50000000-0000-4000-8000-000000000005";
const DIVISION_ID = "60000000-0000-4000-8000-000000000006";
const DISCOVERY_REVISION = "70000000-0000-4000-8000-000000000007";
const INITIAL_STATE = { status: "idle" as const, message: "" };

function formData() {
  const value = new FormData();
  value.set("connectionId", CONNECTION_ID);
  return value;
}

function authenticatedContext(role: string, rpc = vi.fn()) {
  return {
    ok: true,
    user: { id: "40000000-0000-4000-8000-000000000004", email: "admin@example.test" },
    membership: { organizationId: ORGANIZATION_ID, role },
    availableTenants: [],
    supabase: { rpc },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers.mockResolvedValue(new Headers({ origin: "https://app.example", host: "app.example" }));
  mocks.getAppConfig.mockReturnValue({ mode: "production", isDemo: false, supabase: {} });
});

describe("in-product ServiceTitan server actions", () => {
  it("authenticates and verifies tenant admin before creating a service-role client", async () => {
    const order: string[] = [];
    mocks.getTenantAuthContext.mockImplementation(async () => {
      order.push("auth");
      return authenticatedContext("viewer");
    });
    mocks.createServiceRoleSupabaseClient.mockImplementation(() => {
      order.push("service-role");
      return {};
    });

    const state = await validateServiceTitanConnectionAction(INITIAL_STATE, formData());

    expect(state).toMatchObject({ status: "error", operation: "validation", phase: "failed", retryable: false });
    expect(order).toEqual(["auth"]);
    expect(mocks.executeValidation).not.toHaveBeenCalled();
  });

  it("returns a clear ready state without returning service credentials or internal revisions", async () => {
    const serviceClient = { rpc: vi.fn() };
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("admin"));
    mocks.createServiceRoleSupabaseClient.mockReturnValue(serviceClient);
    mocks.executeValidation.mockResolvedValue({ capabilities: ["settings.business_units.read"] });

    const state = await validateServiceTitanConnectionAction(INITIAL_STATE, formData());

    expect(mocks.executeValidation).toHaveBeenCalledWith(serviceClient, ORGANIZATION_ID, CONNECTION_ID);
    expect(state).toEqual({
      status: "success",
      operation: "validation",
      phase: "ready",
      retryable: false,
      message: "ServiceTitan credentials and business-unit access validated. The connection is ready.",
    });
    expect(JSON.stringify(state)).not.toMatch(/secret|token|revision|vault/i);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it("sanitizes provider, Vault, and revision details from retryable validation failures", async () => {
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("owner"));
    mocks.createServiceRoleSupabaseClient.mockReturnValue({ rpc: vi.fn() });
    mocks.executeValidation.mockRejectedValue(new Error(
      "provider body SECRET, supabase-vault://never, configuration revision 9999",
    ));

    const state = await validateServiceTitanConnectionAction(INITIAL_STATE, formData());
    const serialized = JSON.stringify(state);

    expect(state).toMatchObject({
      status: "error",
      operation: "validation",
      phase: "failed",
      retryable: true,
      errorCode: "validation_failed",
    });
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("supabase-vault");
    expect(serialized).not.toContain("9999");
  });

  it("requests and completes discovery in one in-product action without exposing the run ID", async () => {
    const userRpc = vi.fn().mockResolvedValue({ data: DISCOVERY_RUN_ID, error: null });
    const serviceClient = { rpc: vi.fn() };
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("admin", userRpc));
    mocks.createServiceRoleSupabaseClient.mockReturnValue(serviceClient);
    mocks.executeDiscovery.mockResolvedValue({ businessUnitCount: 2 });

    const state = await runBusinessUnitDiscoveryAction(INITIAL_STATE, formData());

    expect(userRpc).toHaveBeenCalledWith("request_service_titan_business_unit_discovery", {
      p_organization_id: ORGANIZATION_ID,
      p_connection_id: CONNECTION_ID,
    });
    expect(mocks.executeDiscovery).toHaveBeenCalledWith(serviceClient, ORGANIZATION_ID, CONNECTION_ID);
    expect(state).toEqual({
      status: "success",
      operation: "business_unit_discovery",
      phase: "completed",
      retryable: false,
      businessUnitCount: 2,
      message: "2 ServiceTitan business units discovered and saved for review.",
    });
    expect(JSON.stringify(state)).not.toContain(DISCOVERY_RUN_ID);
  });

  it("returns a safe retry state when trusted discovery execution fails", async () => {
    const userRpc = vi.fn().mockResolvedValue({ data: DISCOVERY_RUN_ID, error: null });
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("admin", userRpc));
    mocks.createServiceRoleSupabaseClient.mockReturnValue({ rpc: vi.fn() });
    mocks.executeDiscovery.mockRejectedValue(new Error("raw provider payload and internal revision"));

    const state = await runBusinessUnitDiscoveryAction(INITIAL_STATE, formData());

    expect(state).toMatchObject({
      status: "error",
      operation: "business_unit_discovery",
      phase: "failed",
      retryable: true,
      errorCode: "discovery_failed",
    });
    expect(JSON.stringify(state)).not.toMatch(/raw provider payload|internal revision/i);
  });

  it("persists the governed region on location creation", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });
    mocks.getTenantAuthContext.mockResolvedValue({ ...authenticatedContext("admin"), supabase: { from, rpc: vi.fn() } });
    mocks.validateLocationInput.mockReturnValue({
      ok: true,
      value: { locationKey: "dallas", brandName: "LEX Air", displayName: "Dallas", timezone: "America/Chicago", region: "southwest" },
    });
    const data = new FormData();
    data.set("locationKey", "dallas");
    data.set("brandName", "LEX Air");
    data.set("displayName", "Dallas");
    data.set("timezone", "America/Chicago");
    data.set("region", "southwest");

    const state = await createLocationAction(INITIAL_STATE, data);

    expect(mocks.validateLocationInput).toHaveBeenCalledWith(expect.objectContaining({ region: "southwest" }));
    expect(from).toHaveBeenCalledWith("locations");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ organization_id: ORGANIZATION_ID, region: "southwest" }));
    expect(state).toEqual({ status: "success", message: "Location added to the tenant." });
  });

  it("persists a governed region on a tenant-scoped location update", async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.neq = vi.fn(() => chain);
    chain.select = vi.fn(() => chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: LOCATION_ID }, error: null });
    const from = vi.fn().mockReturnValue(chain);
    mocks.getTenantAuthContext.mockResolvedValue({ ...authenticatedContext("owner"), supabase: { from, rpc: vi.fn() } });
    mocks.validateLocationInput.mockReturnValue({
      ok: true,
      value: { locationKey: "rockwall", brandName: "LEX Air", displayName: "Rockwall", timezone: "America/Chicago", region: "southwest" },
    });
    const data = new FormData();
    data.set("locationId", LOCATION_ID);
    data.set("locationKey", "rockwall");
    data.set("brandName", "LEX Air");
    data.set("displayName", "Rockwall");
    data.set("timezone", "America/Chicago");
    data.set("region", "southwest");

    const state = await updateLocationAction(INITIAL_STATE, data);

    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ region: "southwest" }));
    expect(chain.eq).toHaveBeenCalledWith("organization_id", ORGANIZATION_ID);
    expect(chain.eq).toHaveBeenCalledWith("id", LOCATION_ID);
    expect(state).toEqual({ status: "success", message: "Location changes saved." });
  });

  it("creates a normalized tenant division through the narrow authenticated RPC", async () => {
    const userRpc = vi.fn().mockResolvedValue({ data: DIVISION_ID, error: null });
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("admin", userRpc));
    const data = new FormData();
    data.set("name", "  Residential HVAC  ");

    const state = await createDivisionAction(INITIAL_STATE, data);

    expect(userRpc).toHaveBeenCalledWith("create_organization_division", {
      p_organization_id: ORGANIZATION_ID,
      p_name: "Residential HVAC",
    });
    expect(state).toEqual({ status: "success", message: "Residential HVAC division created." });
  });

  it("rejects the reserved Not Mapped division name before any database call", async () => {
    const userRpc = vi.fn();
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("owner", userRpc));
    const data = new FormData();
    data.set("name", "Not Mapped");

    const state = await createDivisionAction(INITIAL_STATE, data);

    expect(state).toMatchObject({ status: "error", fieldErrors: { name: "invalid" } });
    expect(userRpc).not.toHaveBeenCalled();
  });

  it("replaces mappings through the division-native RPC with exact submitted pairs", async () => {
    const userRpc = vi.fn().mockResolvedValue({ data: 1, error: null });
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("admin", userRpc));
    const data = new FormData();
    data.set("connectionId", CONNECTION_ID);
    data.set("discoveryRevision", DISCOVERY_REVISION);
    data.set("confirmMappings", "yes");
    data.append("providerBusinessUnitId", "BU-101");
    data.append("mappedLocationId", LOCATION_ID);
    data.append("divisionId", DIVISION_ID);

    const state = await replaceBusinessUnitMappingsAction(INITIAL_STATE, data);

    expect(userRpc).toHaveBeenCalledWith("replace_service_titan_business_unit_division_mappings", {
      p_organization_id: ORGANIZATION_ID,
      p_connection_id: CONNECTION_ID,
      p_discovery_revision: DISCOVERY_REVISION,
      p_mappings: [{ locationId: LOCATION_ID, providerBusinessUnitId: "BU-101", divisionId: DIVISION_ID }],
    });
    expect(state).toEqual({ status: "success", message: "1 current business-unit mapping saved against the reviewed discovery revision." });
  });

  it("returns an actionable message when an in-use division cannot be archived", async () => {
    const userRpc = vi.fn().mockResolvedValue({ data: null, error: { code: "55000", message: "blocked" } });
    mocks.getTenantAuthContext.mockResolvedValue(authenticatedContext("owner", userRpc));
    const data = new FormData();
    data.set("divisionId", DIVISION_ID);
    data.set("status", "archived");

    const state = await setDivisionStatusAction(INITIAL_STATE, data);

    expect(state).toEqual({ status: "error", message: "Reassign or unmap every active business unit before archiving this division." });
  });
});
