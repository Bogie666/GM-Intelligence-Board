import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ getTenantAuthContext: vi.fn() }));

import { getBusinessUnitMappingReadiness } from "./business-unit-mapping-readiness";
import {
  getTenantReadiness,
  validateBusinessUnitMappingInput,
  validateConnectionCredentialInput,
  validateConnectionInput,
  validateDivisionInput,
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
        region: " Southwest ",
      }),
    ).toEqual({
      ok: true,
      value: {
        locationKey: "denver-west",
        brandName: "Mountain Air",
        displayName: "Denver West",
        timezone: "America/Denver",
        region: "southwest",
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
    [{ locationKey: "a", brandName: "Brand", displayName: "Place", timezone: "UTC", region: "west" }, "locationKey"],
    [{ locationKey: "valid-key", brandName: "", displayName: "Place", timezone: "UTC", region: "west" }, "brandName"],
    [{ locationKey: "valid-key", brandName: "Brand", displayName: "Place", timezone: "Mars/Olympus", region: "west" }, "timezone"],
    [{ locationKey: "valid-key", brandName: "Brand", displayName: "Place", timezone: "Europe/London", region: "west" }, "timezone"],
    [{ locationKey: "valid-key", brandName: "Brand\u0000", displayName: "Place", timezone: "UTC", region: "west" }, "brandName"],
    [{ locationKey: "valid-key", brandName: "Brand", displayName: "Place", timezone: "America/Chicago", region: "southeast" }, "region"],
    [{ locationKey: "valid-key", brandName: "Brand", displayName: "Place", timezone: "America/Chicago", region: "" }, "region"],
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

  it("normalizes printable division names and enforces case-insensitive uniqueness", () => {
    expect(validateDivisionInput({ name: "  Residential HVAC  " }, ["Plumbing"])).toEqual({
      ok: true,
      value: { name: "Residential HVAC" },
    });

    const duplicate = validateDivisionInput({ name: " plumbing " }, ["Plumbing"]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.fieldErrors).toHaveProperty("name");
  });

  it.each([
    "",
    " ",
    "x".repeat(81),
    "Residential\u0000HVAC",
    "Residential\u0085HVAC",
    "Not Mapped",
    "NOT MAPPED",
    "unmapped",
    " UnMapped ",
  ])("rejects unsafe or reserved division name %j", (name) => {
    const result = validateDivisionInput({ name });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty("name");
  });

  it("validates UUID-based division mapping inputs without changing provider identifiers", () => {
    expect(validateBusinessUnitMappingInput({
      locationId: " 40d85f1a-10b4-42c9-92ca-5f73bca9178d ",
      providerBusinessUnitId: "BU-100",
      divisionId: "50d85f1a-10b4-42c9-92ca-5f73bca9178e",
    })).toEqual({
      ok: true,
      value: {
        locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d",
        providerBusinessUnitId: "BU-100",
        divisionId: "50d85f1a-10b4-42c9-92ca-5f73bca9178e",
      },
    });

    for (const input of [
      { locationId: "not-a-uuid", providerBusinessUnitId: "BU-100", divisionId: "50d85f1a-10b4-42c9-92ca-5f73bca9178e" },
      { locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d", providerBusinessUnitId: "BU-100", divisionId: "not-a-uuid" },
      { locationId: "40d85f1a-10b4-42c9-92ca-5f73bca9178d", providerBusinessUnitId: " BU-100 ", divisionId: "50d85f1a-10b4-42c9-92ca-5f73bca9178e" },
    ]) {
      expect(validateBusinessUnitMappingInput(input).ok).toBe(false);
    }
  });
});

describe("getBusinessUnitMappingReadiness", () => {
  const connectionId = "20000000-0000-4000-8000-000000000002";
  const currentRevision = "30000000-0000-4000-8000-000000000003";
  const currentUnits = [
    { connection_id: connectionId, discovery_revision: currentRevision, provider_business_unit_id: "BU-1", active: true },
    { connection_id: connectionId, discovery_revision: currentRevision, provider_business_unit_id: "BU-2", active: true },
    { connection_id: connectionId, discovery_revision: currentRevision, provider_business_unit_id: "BU-INACTIVE", active: false },
    { connection_id: "other-connection", discovery_revision: currentRevision, provider_business_unit_id: "BU-OTHER", active: true },
  ];
  const activeDivisionId = "40000000-0000-4000-8000-000000000004";
  const archivedDivisionId = "50000000-0000-4000-8000-000000000005";
  const activeLocationId = "60000000-0000-4000-8000-000000000006";
  const divisions = [
    { id: activeDivisionId, status: "active" as const },
    { id: archivedDivisionId, status: "archived" as const },
  ];
  const mapping = (providerId: string, overrides: Record<string, unknown> = {}) => ({
    connection_id: connectionId,
    discovery_revision: currentRevision,
    provider_business_unit_id: providerId,
    location_id: activeLocationId,
    division_id: activeDivisionId,
    revoked_at: null,
    ...overrides,
  });

  it("is complete only for exact active coverage on one connection and current revision", () => {
    expect(getBusinessUnitMappingReadiness({
      connectionId,
      discoveryRevision: currentRevision,
      businessUnits: currentUnits,
      divisions,
      activeAssignedLocationIds: [activeLocationId],
      mappings: [
        mapping("BU-1"),
        mapping("BU-2"),
        mapping("BU-1", { discovery_revision: "stale-revision" }),
        mapping("BU-2", { connection_id: "other-connection" }),
        mapping("BU-INACTIVE"),
      ],
    })).toEqual({
      activeBusinessUnitCount: 2,
      activeDivisionCount: 1,
      mappedBusinessUnitCount: 2,
      complete: true,
    });
  });

  it.each([
    ["no active divisions", [], [mapping("BU-1"), mapping("BU-2")]],
    ["missing coverage", divisions, [mapping("BU-1")]],
    ["duplicate coverage", divisions, [mapping("BU-1"), mapping("BU-1"), mapping("BU-2")]],
    ["archived division mapping", divisions, [mapping("BU-1"), mapping("BU-2", { division_id: archivedDivisionId })]],
    ["inactive or unassigned location mapping", divisions, [mapping("BU-1"), mapping("BU-2", { location_id: "70000000-0000-4000-8000-000000000007" })]],
    ["revoked mapping", divisions, [mapping("BU-1"), mapping("BU-2", { revoked_at: "2026-08-19T00:00:00Z" })]],
    ["stale mapping", divisions, [mapping("BU-1"), mapping("BU-2", { discovery_revision: "stale-revision" })]],
  ])("is incomplete for %s", (_label, candidateDivisions, mappings) => {
    expect(getBusinessUnitMappingReadiness({
      connectionId,
      discoveryRevision: currentRevision,
      businessUnits: currentUnits,
      divisions: candidateDivisions,
      activeAssignedLocationIds: [activeLocationId],
      mappings,
    }).complete).toBe(false);
  });

  it("requires at least one current active business unit", () => {
    expect(getBusinessUnitMappingReadiness({
      connectionId,
      discoveryRevision: currentRevision,
      businessUnits: [],
      divisions,
      activeAssignedLocationIds: [activeLocationId],
      mappings: [],
    })).toEqual({
      activeBusinessUnitCount: 0,
      activeDivisionCount: 1,
      mappedBusinessUnitCount: 0,
      complete: false,
    });
  });
});

describe("getTenantReadiness", () => {
  it("derives readiness only from persisted tenant records", () => {
    expect(
      getTenantReadiness(
        [
          { id: "location-1", status: "active", region: "west" },
          { id: "location-2", status: "archived", region: null },
        ],
        [
          { id: "connection-1", status: "needs_attention" },
          { id: "connection-2", status: "disabled" },
        ],
        [{ connection_id: "connection-1", location_id: "location-1", revoked_at: null }],
      ),
    ).toEqual({
      activeLocationCount: 1,
      activeLocationsMissingRegionCount: 0,
      enabledConnectionCount: 1,
      assignedActiveLocationCount: 1,
      isConfigured: true,
      hasValidatedConnection: false,
    });
  });

  it("does not claim configuration or validation without persisted evidence", () => {
    expect(getTenantReadiness([], [], [])).toEqual({
      activeLocationCount: 0,
      activeLocationsMissingRegionCount: 0,
      enabledConnectionCount: 0,
      assignedActiveLocationCount: 0,
      isConfigured: false,
      hasValidatedConnection: false,
    });
  });

  it("keeps setup incomplete until every active location has an explicit region", () => {
    expect(getTenantReadiness(
      [{ id: "location-1", status: "active", region: null }],
      [{ id: "connection-1", status: "ready", last_validated_at: "2026-08-19T12:00:00Z" }],
      [{ connection_id: "connection-1", location_id: "location-1", revoked_at: null }],
    )).toMatchObject({
      activeLocationsMissingRegionCount: 1,
      isConfigured: false,
    });
  });
});
