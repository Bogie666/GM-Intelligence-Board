import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  revalidatePath: vi.fn(),
  getTenantAuthContext: vi.fn(),
  getAppConfig: vi.fn(),
  createServiceRoleSupabaseClient: vi.fn(),
  executeValidation: vi.fn(),
  executeDiscovery: vi.fn(),
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
  validateConnectionCredentialInput: vi.fn(),
  validateCredentialRotationInput: vi.fn(),
  validateLocationInput: vi.fn(),
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
  runBusinessUnitDiscoveryAction,
  validateServiceTitanConnectionAction,
} from "./actions";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000002";
const DISCOVERY_RUN_ID = "30000000-0000-4000-8000-000000000003";
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
});
