import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DataSourceWorkerError,
  governDataSourceBinding,
  inspectCustomEndpointSource,
  inspectDomoDatasetSource,
  validateDomoConnection,
} from "./data-source-workers";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000099";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_ID = "30000000-0000-4000-8000-000000000003";
const BINDING_ID = "40000000-0000-4000-8000-000000000004";
const ACTOR_ID = "50000000-0000-4000-8000-000000000005";
const DEFINITION_ID = "60000000-0000-4000-8000-000000000006";
const LOCATION_ID = "70000000-0000-4000-8000-000000000007";
const SECRET_REFERENCE = "supabase-vault://80000000-0000-4000-8000-000000000008";
const DATASET_ID = "123e4567-e89b-12d3-a456-426614174000";
const SOURCE_FINGERPRINT = "sha256:source-fingerprint-must-remain-private";
const TENANT_ID = "tenant/123";
const TOKEN = "provider-access-token-must-remain-private";

interface QueryCall {
  table: string;
  filters: Array<{ operator: string; column: string; value: unknown }>;
  selected?: string;
}

function mockClient(
  rows: Record<string, unknown | unknown[]>,
  rpcHandler: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> = async () => ({ data: true, error: null }),
) {
  const queries: QueryCall[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const positions = new Map<string, number>();

  function from(table: string) {
    const call: QueryCall = { table, filters: [] };
    queries.push(call);
    const builder = {
      select(columns: string) { call.selected = columns; return builder; },
      eq(column: string, value: unknown) { call.filters.push({ operator: "eq", column, value }); return builder; },
      neq(column: string, value: unknown) { call.filters.push({ operator: "neq", column, value }); return builder; },
      in(column: string, value: unknown) { call.filters.push({ operator: "in", column, value }); return builder; },
      async maybeSingle() {
        const configured = rows[table];
        if (Array.isArray(configured)) {
          const position = positions.get(table) ?? 0;
          positions.set(table, position + 1);
          return { data: configured[position] ?? null, error: null };
        }
        return { data: configured ?? null, error: null };
      },
    };
    return builder;
  }

  return {
    client: {
      from,
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return rpcHandler(name, args);
      },
    },
    queries,
    rpcCalls,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sourceRows() {
  return {
    service_titan_custom_endpoint_sources: {
      id: SOURCE_ID,
      organization_id: ORGANIZATION_ID,
      connection_id: CONNECTION_ID,
      service_titan_tenant_id: TENANT_ID,
      category: "invoices",
      query_parameters: { invoicedOnOrAfter: "$periodStartIso", invoicedBefore: "$periodEndIso" },
      reduction: "count",
      value_field: null,
      business_unit_field: null,
      lifecycle: "draft",
      status: "active",
      canonical_source_fingerprint: SOURCE_FINGERPRINT,
    },
    service_titan_connections: {
      id: CONNECTION_ID,
      organization_id: ORGANIZATION_ID,
      service_titan_tenant_id: TENANT_ID,
      environment: "production",
      status: "ready",
      secret_reference: SECRET_REFERENCE,
    },
  };
}

function domoRows(overrides: Record<string, unknown> = {}) {
  return {
    domo_dataset_sources: {
      id: SOURCE_ID,
      organization_id: ORGANIZATION_ID,
      domo_connection_id: CONNECTION_ID,
      dataset_id: DATASET_ID,
      value_column: "Revenue",
      reduction: "sum",
      date_column: "Posted Date",
      filter_column: "Location",
      filter_value: "Phoenix",
      lifecycle: "draft",
      status: "active",
      canonical_source_fingerprint: SOURCE_FINGERPRINT,
      ...overrides,
    },
    domo_connections: {
      id: CONNECTION_ID,
      organization_id: ORGANIZATION_ID,
      status: "ready",
      secret_reference: SECRET_REFERENCE,
    },
  };
}

function expectExactFilter(call: QueryCall, column: string, value: unknown) {
  expect(call.filters).toContainEqual({ operator: "eq", column, value });
}

describe("custom ServiceTitan source inspection", () => {
  it("enforces the exact tenant/source/connection chain, calls the fingerprint RPC, and returns counts only", async () => {
    const mock = mockClient(sourceRows(), async (name) => {
      if (name === "resolve_service_titan_connection_secret") {
        return { data: JSON.stringify({ clientId: "client-id", clientSecret: "client-secret", appKey: "app-key-value" }), error: null };
      }
      return { data: true, error: null };
    });
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).endsWith("/connect/token")) return jsonResponse({ access_token: TOKEN });
      return jsonResponse({ data: [{ id: 1 }, { id: 2 }], hasMore: false });
    }) as unknown as typeof fetch;

    const result = await inspectCustomEndpointSource(
      mock.client as never,
      ORGANIZATION_ID,
      SOURCE_ID,
      { start: new Date("2020-01-01T00:00:00.000Z"), end: new Date("2020-01-02T00:00:00.000Z") },
      { fetchImpl, sleep: async () => {}, now: Date.now },
    );

    expect(result).toEqual({ rowCount: 2, totalRowCount: 2, pageCount: 1 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(SOURCE_FINGERPRINT);

    const sourceQuery = mock.queries.find((query) => query.table === "service_titan_custom_endpoint_sources")!;
    expectExactFilter(sourceQuery, "organization_id", ORGANIZATION_ID);
    expectExactFilter(sourceQuery, "id", SOURCE_ID);
    expectExactFilter(sourceQuery, "status", "active");
    const connectionQuery = mock.queries.find((query) => query.table === "service_titan_connections")!;
    expectExactFilter(connectionQuery, "organization_id", ORGANIZATION_ID);
    expectExactFilter(connectionQuery, "id", CONNECTION_ID);
    expectExactFilter(connectionQuery, "service_titan_tenant_id", TENANT_ID);
    expectExactFilter(connectionQuery, "status", "ready");

    expect(mock.rpcCalls.at(-1)).toEqual({
      name: "inspect_service_titan_custom_endpoint_source",
      args: {
        p_organization_id: ORGANIZATION_ID,
        p_source_id: SOURCE_ID,
        p_expected_fingerprint: SOURCE_FINGERPRINT,
      },
    });
    expect(fetchCalls).toHaveLength(2);
  });

  it("fails closed when an exact tenant-scoped source is unavailable", async () => {
    const mock = mockClient({ ...sourceRows(), service_titan_custom_endpoint_sources: null });
    await expect(inspectCustomEndpointSource(
      mock.client as never,
      OTHER_ORGANIZATION_ID,
      SOURCE_ID,
      { start: new Date("2020-01-01T00:00:00.000Z"), end: new Date("2020-01-02T00:00:00.000Z") },
    )).rejects.toMatchObject({ code: "custom_source_unavailable" });
    expect(mock.rpcCalls).toEqual([]);
  });
});

describe("Domo connection validation", () => {
  it("uses a bounded OAuth GET and persists a ready status without returning credentials or tokens", async () => {
    const mock = mockClient({ domo_connections: domoRows().domo_connections }, async (name) => {
      if (name === "resolve_domo_connection_secret") {
        return { data: JSON.stringify({ clientId: "domo-client", clientSecret: "domo-secret" }), error: null };
      }
      return { data: true, error: null };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.domo.com/oauth/token?grant_type=client_credentials&scope=data");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return jsonResponse({ access_token: TOKEN });
    }) as unknown as typeof fetch;

    const result = await validateDomoConnection(mock.client as never, ORGANIZATION_ID, CONNECTION_ID, {
      fetchImpl,
      sleep: async () => {},
      now: Date.now,
    });

    expect(result).toEqual({ status: "ready", capabilities: ["data"] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(mock.rpcCalls.at(-1)).toEqual({
      name: "set_domo_connection_status",
      args: {
        p_organization_id: ORGANIZATION_ID,
        p_connection_id: CONNECTION_ID,
        p_status: "ready",
        p_error_code: null,
      },
    });
  });

  it("persists one stable failure code and does not expose a provider body or secret", async () => {
    const providerBody = "raw-provider-body-never-expose";
    const credential = "credential-never-expose";
    const mock = mockClient({ domo_connections: domoRows().domo_connections }, async (name) => {
      if (name === "resolve_domo_connection_secret") {
        return { data: JSON.stringify({ clientId: "domo-client", clientSecret: credential }), error: null };
      }
      return { data: true, error: null };
    });

    let thrown: unknown;
    try {
      await validateDomoConnection(mock.client as never, ORGANIZATION_ID, CONNECTION_ID, {
        fetchImpl: (async () => jsonResponse({ detail: providerBody }, 401)) as typeof fetch,
        sleep: async () => {},
        now: Date.now,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DataSourceWorkerError);
    expect(thrown).toMatchObject({ code: "domo_validation_failed", message: "Domo connection validation failed." });
    expect(JSON.stringify(thrown)).not.toContain(providerBody);
    expect(JSON.stringify(thrown)).not.toContain(credential);
    expect(mock.rpcCalls.at(-1)).toEqual({
      name: "set_domo_connection_status",
      args: {
        p_organization_id: ORGANIZATION_ID,
        p_connection_id: CONNECTION_ID,
        p_status: "needs_attention",
        p_error_code: "validation_failed",
      },
    });
  });
});

describe("Domo dataset source inspection", () => {
  it("checks all configured columns before an exact-fingerprint transition and returns sanitized metadata", async () => {
    const mock = mockClient(domoRows(), async (name) => {
      if (name === "resolve_domo_connection_secret") {
        return { data: JSON.stringify({ clientId: "domo-client", clientSecret: "domo-secret" }), error: null };
      }
      return { data: true, error: null };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/token")) return jsonResponse({ access_token: TOKEN });
      if (href.endsWith(`/v1/datasets/${DATASET_ID}`)) {
        return jsonResponse({ id: DATASET_ID, name: "  Executive Finance  ", rows: 2, columns: 3, ignoredSecret: "provider-private" });
      }
      return new Response("Revenue,Posted Date,Location\n10,2020-01-01,Phoenix\n20,2020-01-02,Phoenix\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }) as unknown as typeof fetch;

    const result = await inspectDomoDatasetSource(mock.client as never, ORGANIZATION_ID, SOURCE_ID, {
      fetchImpl,
      sleep: async () => {},
      now: Date.now,
    });

    expect(result).toEqual({ datasetName: "Executive Finance", rowCount: 2, columnCount: 3 });
    expect(JSON.stringify(result)).not.toContain("provider-private");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(SOURCE_FINGERPRINT);
    const sourceQuery = mock.queries.find((query) => query.table === "domo_dataset_sources")!;
    expectExactFilter(sourceQuery, "organization_id", ORGANIZATION_ID);
    expectExactFilter(sourceQuery, "id", SOURCE_ID);
    expectExactFilter(sourceQuery, "status", "active");
    const connectionQuery = mock.queries.find((query) => query.table === "domo_connections")!;
    expectExactFilter(connectionQuery, "organization_id", ORGANIZATION_ID);
    expectExactFilter(connectionQuery, "id", CONNECTION_ID);
    expectExactFilter(connectionQuery, "status", "ready");
    expect(mock.rpcCalls.at(-1)).toEqual({
      name: "inspect_domo_dataset_source",
      args: {
        p_organization_id: ORGANIZATION_ID,
        p_source_id: SOURCE_ID,
        p_expected_fingerprint: SOURCE_FINGERPRINT,
      },
    });
  });

  it("does not mark a source inspected if a configured value/date/filter column is absent", async () => {
    const mock = mockClient(domoRows(), async (name) => {
      if (name === "resolve_domo_connection_secret") {
        return { data: JSON.stringify({ clientId: "domo-client", clientSecret: "domo-secret" }), error: null };
      }
      return { data: true, error: null };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/token")) return jsonResponse({ access_token: TOKEN });
      if (href.endsWith(`/v1/datasets/${DATASET_ID}`)) return jsonResponse({ id: DATASET_ID, name: "Finance", rows: 1, columns: 2 });
      return new Response("Revenue,Posted Date\n10,2020-01-01\n");
    }) as unknown as typeof fetch;

    await expect(inspectDomoDatasetSource(mock.client as never, ORGANIZATION_ID, SOURCE_ID, {
      fetchImpl,
      sleep: async () => {},
      now: Date.now,
    })).rejects.toMatchObject({ code: "domo_configured_column_missing" });
    expect(mock.rpcCalls.some((call) => call.name === "inspect_domo_dataset_source")).toBe(false);
  });

  it("fails safely when the inspection RPC rejects a stale fingerprint", async () => {
    const mock = mockClient(domoRows(), async (name) => {
      if (name === "resolve_domo_connection_secret") {
        return { data: JSON.stringify({ clientId: "domo-client", clientSecret: "domo-secret" }), error: null };
      }
      if (name === "inspect_domo_dataset_source") return { data: null, error: { code: "40001", message: SOURCE_FINGERPRINT } };
      return { data: true, error: null };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/token")) return jsonResponse({ access_token: TOKEN });
      if (href.endsWith(`/v1/datasets/${DATASET_ID}`)) return jsonResponse({ id: DATASET_ID, name: "Finance", rows: 1, columns: 3 });
      return new Response("Revenue,Posted Date,Location\n10,2020-01-01,Phoenix\n");
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await inspectDomoDatasetSource(mock.client as never, ORGANIZATION_ID, SOURCE_ID, { fetchImpl, sleep: async () => {}, now: Date.now });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "domo_inspection_stale", message: "The Domo dataset source changed during inspection." });
    expect(JSON.stringify(thrown)).not.toContain(SOURCE_FINGERPRINT);
  });
});

describe("data-source binding governance", () => {
  function binding(method: "custom_endpoint" | "domo_dataset") {
    return {
      id: BINDING_ID,
      organization_id: ORGANIZATION_ID,
      kpi_definition_id: DEFINITION_ID,
      location_id: LOCATION_ID,
      connection_id: method === "custom_endpoint" ? CONNECTION_ID : null,
      service_titan_tenant_id: method === "custom_endpoint" ? TENANT_ID : null,
      source_method: method,
      endpoint_recipe_id: null,
      endpoint_recipe_version: null,
      custom_endpoint_source_id: method === "custom_endpoint" ? SOURCE_ID : null,
      domo_connection_id: method === "domo_dataset" ? CONNECTION_ID : null,
      domo_dataset_source_id: method === "domo_dataset" ? SOURCE_ID : null,
      business_unit_mappings: {},
      approval_status: "draft",
    };
  }

  it("re-fetches the exact binding, rejects a method mismatch before sampling, and ignores browser method fields", async () => {
    const mock = mockClient({ custom_kpi_location_bindings: binding("domo_dataset") });
    await expect(governDataSourceBinding(
      mock.client as never,
      {
        organizationId: ORGANIZATION_ID,
        bindingId: BINDING_ID,
        actorProfileId: ACTOR_ID,
        periodStart: "2020-01-01T00:00:00.000Z",
        periodEnd: "2020-01-02T00:00:00.000Z",
        referenceValue: "2",
        tolerance: "0",
        sourceMethod: "custom_endpoint",
      } as never,
      "custom_endpoint",
    )).rejects.toMatchObject({ code: "binding_method_mismatch" });

    expect(mock.queries).toHaveLength(1);
    expectExactFilter(mock.queries[0], "organization_id", ORGANIZATION_ID);
    expectExactFilter(mock.queries[0], "id", BINDING_ID);
    expect(mock.rpcCalls).toEqual([]);
  });

  it("uses the auth-derived actor and worker-computed custom-endpoint sample in exact approval RPC arguments", async () => {
    const customBinding = binding("custom_endpoint");
    const mock = mockClient({
      custom_kpi_location_bindings: [customBinding, customBinding],
      organization_memberships: { profile_id: ACTOR_ID, role: "admin", status: "active" },
      ...sourceRows(),
    }, async (name) => {
      if (name === "resolve_service_titan_connection_secret") {
        return { data: JSON.stringify({ clientId: "client-id", clientSecret: "client-secret", appKey: "app-key-value" }), error: null };
      }
      if (name === "approve_service_titan_custom_endpoint_binding") {
        return { data: { approved: true, delta: "0", tolerance: "0", sourceFingerprint: SOURCE_FINGERPRINT }, error: null };
      }
      return { data: true, error: null };
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/connect/token")) return jsonResponse({ access_token: TOKEN });
      return jsonResponse({ data: [{ id: 1 }, { id: 2 }], hasMore: false });
    }) as unknown as typeof fetch;

    const result = await governDataSourceBinding(
      mock.client as never,
      {
        organizationId: ORGANIZATION_ID,
        bindingId: BINDING_ID,
        actorProfileId: ACTOR_ID,
        periodStart: "2020-01-01T00:00:00.000Z",
        periodEnd: "2020-01-02T00:00:00.000Z",
        referenceValue: "2",
        tolerance: "0",
      },
      "custom_endpoint",
      { fetchImpl, sleep: async () => {}, now: Date.now },
    );

    expect(result).toEqual({ approved: true, delta: "0", tolerance: "0", rowCount: 2 });
    expect(JSON.stringify(result)).not.toContain(SOURCE_FINGERPRINT);
    const approval = mock.rpcCalls.find((call) => call.name === "approve_service_titan_custom_endpoint_binding")!;
    expect(approval.args).toMatchObject({
      p_organization_id: ORGANIZATION_ID,
      p_source_id: SOURCE_ID,
      p_binding_id: BINDING_ID,
      p_actor_profile_id: ACTOR_ID,
      p_row_count: 2,
      p_computed_value: "2",
      p_reference_value: "2",
      p_tolerance: "0",
      p_period_start: "2020-01-01T00:00:00.000Z",
      p_period_end: "2020-01-02T00:00:00.000Z",
    });
    expect(mock.queries.filter((query) => query.table === "custom_kpi_location_bindings")).toHaveLength(2);
  });
});
