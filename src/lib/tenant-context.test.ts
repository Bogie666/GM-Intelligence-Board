import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ getTenantAuthContext: vi.fn() }));

import {
  getTenantReadiness,
  validateConnectionCredentialInput,
  validateConnectionInput,
  validateLocationInput,
  validateOrganizationInput,
  validateUuid,
} from "./tenant-context";

describe("tenant control-plane validation", () => {
  it("normalizes valid organization and location fields", () => {
    expect(validateOrganizationInput({ slug: "  Good-Group  ", name: "  Good Group  " })).toEqual({
      ok: true,
      value: { slug: "good-group", name: "Good Group" },
    });
    expect(
      validateLocationInput({
        locationKey: "  Denver-West  ",
        brandName: "  Mountain Air  ",
        displayName: "  Denver West  ",
        timezone: " America/Denver ",
      }),
    ).toEqual({
      ok: true,
      value: {
        locationKey: "denver-west",
        brandName: "Mountain Air",
        displayName: "Denver West",
        timezone: "America/Denver",
      },
    });
  });

  it.each([
    [{ slug: "ab", name: "Valid" }, "slug"],
    [{ slug: "Bad Slug", name: "Valid" }, "slug"],
    [{ slug: "valid-slug", name: "  " }, "name"],
  ])("rejects invalid organization input %#", (input, field) => {
    const result = validateOrganizationInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty(field as string);
  });

  it.each([
    [{ locationKey: "a", brandName: "Brand", displayName: "Place", timezone: "UTC" }, "locationKey"],
    [{ locationKey: "valid-key", brandName: "", displayName: "Place", timezone: "UTC" }, "brandName"],
    [{ locationKey: "valid-key", brandName: "Brand", displayName: "Place", timezone: "Mars/Olympus" }, "timezone"],
    [{ locationKey: "valid-key", brandName: "Brand", displayName: "Place", timezone: "Europe/London" }, "timezone"],
    [{ locationKey: "valid-key", brandName: "Brand\u0000", displayName: "Place", timezone: "UTC" }, "brandName"],
  ])("rejects invalid location input %#", (input, field) => {
    const result = validateLocationInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty(field as string);
  });

  it("accepts only credential-free ServiceTitan metadata and a managed-secret reference", () => {
    expect(
      validateConnectionInput({
        tenantId: "tenant_123-ABC",
        displayName: " Primary ServiceTitan ",
        environment: "production",
        secretReference: "gcp-secret://projects/gmib/secrets/tenant-123/versions/latest",
        locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d",
      }),
    ).toEqual({
      ok: true,
      value: {
        tenantId: "tenant_123-ABC",
        displayName: "Primary ServiceTitan",
        environment: "production",
        secretReference: "gcp-secret://projects/gmib/secrets/tenant-123/versions/latest",
        locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d",
      },
    });
  });

  it("accepts ServiceTitan credentials for server-side Vault encryption", () => {
    expect(
      validateConnectionCredentialInput({
        tenantId: "tenant_123-ABC",
        displayName: " LEX DFW Production ",
        environment: "production",
        clientId: "client-id-value",
        clientSecret: "client-secret-value",
        appKey: "actual-st-app-key",
        locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d",
      }),
    ).toEqual({
      ok: true,
      value: {
        tenantId: "tenant_123-ABC",
        displayName: "LEX DFW Production",
        environment: "production",
        clientId: "client-id-value",
        clientSecret: "client-secret-value",
        appKey: "actual-st-app-key",
        locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d",
      },
    });
  });

  it.each([
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", clientId: "", clientSecret: "secret", appKey: "key" }, "clientId"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", clientId: "id", clientSecret: " secret", appKey: "key" }, "clientSecret"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", clientId: "id", clientSecret: "secret", appKey: "key\n" }, "appKey"],
  ])("rejects unsafe ServiceTitan credential input %#", (input, field) => {
    const result = validateConnectionCredentialInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty(field as string);
  });

  it.each([
    [{ tenantId: "", displayName: "Primary", environment: "production", secretReference: "gcp-secret://projects/gmib/secrets/ref" }, "tenantId"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "sandbox", secretReference: "gcp-secret://projects/gmib/secrets/ref" }, "environment"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "raw-secret-value" }, "secretReference"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "password://this-is-a-secret" }, "secretReference"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "eyJhbGciOiJIUzI1NiJ9.payload.signature" }, "secretReference"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "supabase-vault://future-resolver" }, "secretReference"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "env://lowercase" }, "secretReference"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "gcp-secret://projects/gmib/secrets/ref/versions/zero" }, "secretReference"],
    [{ tenantId: "tenant", displayName: "Primary", environment: "production", secretReference: "gcp-secret://projects/gmib/secrets/ref", locationId: "not-a-uuid" }, "locationId"],
  ])("rejects unsafe connection metadata %#", (input, field) => {
    const result = validateConnectionInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty(field as string);
  });

  it("validates canonical UUIDs", () => {
    expect(validateUuid("40d85f1a-10b4-42c9-92ca-5f73bca9178d")).toBe(true);
    expect(validateUuid("40D85F1A-10B4-42C9-92CA-5F73BCA9178D")).toBe(true);
    expect(validateUuid("40d85f1a10b442c992ca5f73bca9178d")).toBe(false);
  });
});

describe("getTenantReadiness", () => {
  it("derives readiness only from persisted tenant records", () => {
    expect(
      getTenantReadiness(
        [
          { id: "location-1", status: "active" },
          { id: "location-2", status: "archived" },
        ],
        [
          { id: "connection-1", status: "needs_attention" },
          { id: "connection-2", status: "disabled" },
        ],
        [{ connection_id: "connection-1", location_id: "location-1", revoked_at: null }],
      ),
    ).toEqual({
      activeLocationCount: 1,
      enabledConnectionCount: 1,
      assignedActiveLocationCount: 1,
      isConfigured: true,
      hasValidatedConnection: false,
    });
  });

  it("does not claim configuration or validation without persisted evidence", () => {
    expect(getTenantReadiness([], [], [])).toEqual({
      activeLocationCount: 0,
      enabledConnectionCount: 0,
      assignedActiveLocationCount: 0,
      isConfigured: false,
      hasValidatedConnection: false,
    });
  });
});
