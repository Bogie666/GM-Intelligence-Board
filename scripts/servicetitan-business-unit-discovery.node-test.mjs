import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryError,
  MAX_BUSINESS_UNIT_PAGES,
  discoverBusinessUnits,
  fetchWithDiscoveryPolicy,
  normalizeBusinessUnit,
  normalizeBusinessUnitPage,
  parseWorkerContext,
  runBusinessUnitDiscovery,
} from "./lib/servicetitan-business-unit-discovery.mjs";
import { resolveDiscoveryCredentials } from "./discover-servicetitan-business-units.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000002";
const CONFIGURATION_REVISION = "30000000-0000-4000-8000-000000000003";
const DISCOVERY_RUN_ID = "40000000-0000-4000-8000-000000000004";
const CREDENTIALS = {
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  appKey: "application-key-value",
};
const TOKEN = "access-token-value-that-is-long-enough";

function context(overrides = {}) {
  return {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    serviceTitanTenantId: "tenant/123",
    environment: "production",
    secretReference: "env://SERVICE_TITAN_TEST_CREDENTIAL",
    configurationRevision: CONFIGURATION_REVISION,
    status: "ready",
    requestedDiscoveryRunId: DISCOVERY_RUN_ID,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rpcResult(data) {
  return { data, error: null };
}

test("business-unit normalization emits only the bounded governed inventory shape", () => {
  assert.deepEqual(normalizeBusinessUnit({
    id: 42,
    name: "  HVAC Service  ",
    active: true,
    modifiedOn: "2026-08-19T10:30:00-04:00",
    ignoredProviderField: { anything: "is not persisted" },
  }), {
    providerBusinessUnitId: "42",
    name: "HVAC Service",
    active: true,
    providerModifiedAt: "2026-08-19T14:30:00.000Z",
  });
  assert.deepEqual(normalizeBusinessUnit({ id: "external-7", name: "Plumbing", active: false }), {
    providerBusinessUnitId: "external-7",
    name: "Plumbing",
    active: false,
  });
});

test("business-unit normalization rejects unsafe IDs, control characters, bad timestamps, and pagination drift", () => {
  assert.throws(() => normalizeBusinessUnit({ id: Number.MAX_SAFE_INTEGER + 1, name: "HVAC", active: true }), DiscoveryError);
  assert.throws(() => normalizeBusinessUnit({ id: "1", name: "HVAC\nsecret", active: true }), DiscoveryError);
  assert.throws(() => normalizeBusinessUnit({ id: "1", name: "HVAC", active: "true" }), DiscoveryError);
  assert.throws(() => normalizeBusinessUnit({ id: "1", name: "HVAC", active: true, modifiedOn: "yesterday" }), DiscoveryError);
  assert.throws(() => normalizeBusinessUnitPage({ data: [], hasMore: true }), /pagination/);
  assert.throws(() => normalizeBusinessUnitPage({ data: [] }), /invalid/);
});

test("worker context is exact, revision-pinned, enabled, and requires a requested run", () => {
  assert.equal(parseWorkerContext(context(), ORGANIZATION_ID, CONNECTION_ID).discoveryRunId, DISCOVERY_RUN_ID);
  assert.equal(parseWorkerContext(context({ status: "needs_attention" }), ORGANIZATION_ID, CONNECTION_ID).discoveryRunId, DISCOVERY_RUN_ID);
  for (const malformed of [
    context({ requestedDiscoveryRunId: null }),
    context({ status: "archived" }),
    context({ configurationRevision: "not-a-uuid" }),
    context({ organizationId: "50000000-0000-4000-8000-000000000005" }),
  ]) {
    assert.throws(() => parseWorkerContext(malformed, ORGANIZATION_ID, CONNECTION_ID), /context/);
  }
});

test("network policy denies redirects and never forwards credentials", async () => {
  let observedInit;
  const fetchImpl = async (_url, init) => {
    observedInit = init;
    return new Response(null, { status: 307, headers: { location: "https://untrusted.example/" } });
  };
  await assert.rejects(
    fetchWithDiscoveryPolicy("https://api.servicetitan.io/settings/v2/tenant/t/business-units", {
      headers: { authorization: "Bearer never-forward" },
    }, "business_units", { fetchImpl, sleep: async () => {} }),
    (error) => error instanceof DiscoveryError && error.code === "business_units_http_307",
  );
  assert.equal(observedInit.redirect, "error");
});

test("network policy applies an abort timeout and bounded attempts", async () => {
  let attemptCount = 0;
  const fetchImpl = async (_url, init) => {
    attemptCount += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    });
  };
  await assert.rejects(
    fetchWithDiscoveryPolicy("https://auth.servicetitan.io/connect/token", {}, "oauth", {
      fetchImpl,
      sleep: async () => {},
      timeoutMs: 5,
      maximumAttempts: 2,
    }),
    (error) => error instanceof DiscoveryError && error.code === "oauth_network",
  );
  assert.equal(attemptCount, 2);
});

test("business-unit discovery paginates completely, uses integration origin, and sorts normalized IDs", async () => {
  const calls = [];
  const pages = [
    { data: [{ id: "20", name: "Plumbing", active: true }], hasMore: true },
    { data: [{ id: "10", name: "HVAC", active: false, modifiedOn: "2026-08-19T00:00:00Z" }], hasMore: false },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(pages.shift());
  };
  const inventory = await discoverBusinessUnits({
    credentials: CREDENTIALS,
    token: TOKEN,
    connection: { ...context({ environment: "integration" }), discoveryRunId: DISCOVERY_RUN_ID },
  }, { fetchImpl, sleep: async () => {} });
  assert.deepEqual(inventory.map((item) => item.providerBusinessUnitId), ["10", "20"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api-integration\.servicetitan\.io\/settings\/v2\/tenant\/tenant%2F123\/business-units\?page=1&pageSize=500$/);
  assert.match(calls[1].url, /page=2&pageSize=500$/);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["ST-App-Key"], CREDENTIALS.appKey);
});

test("business-unit pagination fails closed at the fixed page limit", async () => {
  let page = 0;
  const fetchImpl = async () => {
    page += 1;
    return jsonResponse({ data: [{ id: String(page), name: `Unit ${page}`, active: true }], hasMore: true });
  };
  await assert.rejects(
    discoverBusinessUnits({
      credentials: CREDENTIALS,
      token: TOKEN,
      connection: context(),
    }, { fetchImpl, sleep: async () => {} }),
    (error) => error instanceof DiscoveryError && error.code === "business_units_page_limit",
  );
  assert.equal(page, MAX_BUSINESS_UNIT_PAGES);
});

test("worker stops before credentials or provider access when governed start rejects stale state", async () => {
  const rpcCalls = [];
  let resolvedCredentials = false;
  const rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "get_service_titan_connection_worker_context") return rpcResult(context({ status: "needs_attention" }));
    if (name === "start_service_titan_business_unit_discovery") return rpcResult(false);
    throw new Error("unexpected RPC");
  };
  await assert.rejects(
    runBusinessUnitDiscovery({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      rpc,
      resolveCredentials: async () => { resolvedCredentials = true; return CREDENTIALS; },
      fetchImpl: async () => { throw new Error("provider must not be called"); },
      sleep: async () => {},
    }),
    (error) => error instanceof DiscoveryError && error.code === "discovery_start_rejected",
  );
  assert.equal(resolvedCredentials, false);
  assert.deepEqual(rpcCalls.map((call) => call.name), [
    "get_service_titan_connection_worker_context",
    "start_service_titan_business_unit_discovery",
  ]);
  assert.equal(rpcCalls[1].args.p_configuration_revision, CONFIGURATION_REVISION);
});

test("worker uses governed context/start/complete RPCs with the exact configuration revision", async () => {
  const rpcCalls = [];
  const providerCalls = [];
  const rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "get_service_titan_connection_worker_context") return rpcResult(context());
    return rpcResult(true);
  };
  const fetchImpl = async (url, init) => {
    providerCalls.push({ url, init });
    if (url.endsWith("/connect/token")) return jsonResponse({ access_token: TOKEN, token_type: "Bearer" });
    return jsonResponse({
      data: [
        { id: 9, name: "Electrical", active: true, modifiedOn: null, providerSecret: "discarded" },
        { id: 3, name: "HVAC", active: true },
      ],
      hasMore: false,
      rawMetadata: { discarded: true },
    });
  };
  const result = await runBusinessUnitDiscovery({
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    rpc,
    resolveCredentials: async () => CREDENTIALS,
    fetchImpl,
    sleep: async () => {},
  });

  assert.deepEqual(result, { discoveryRunId: DISCOVERY_RUN_ID, businessUnitCount: 2 });
  assert.deepEqual(rpcCalls.map((call) => call.name), [
    "get_service_titan_connection_worker_context",
    "start_service_titan_business_unit_discovery",
    "complete_service_titan_business_unit_discovery",
  ]);
  assert.deepEqual(rpcCalls[0].args, {
    p_organization_id: ORGANIZATION_ID,
    p_connection_id: CONNECTION_ID,
    p_purpose: "discovery",
  });
  const completion = rpcCalls[2].args;
  assert.equal(completion.p_configuration_revision, CONFIGURATION_REVISION);
  assert.equal(completion.p_discovery_run_id, DISCOVERY_RUN_ID);
  assert.equal(completion.p_error_code, null);
  assert.equal(completion.p_error_message, null);
  assert.deepEqual(completion.p_inventory, [
    { providerBusinessUnitId: "3", name: "HVAC", active: true },
    { providerBusinessUnitId: "9", name: "Electrical", active: true },
  ]);
  assert.equal(providerCalls.length, 2);
});

test("worker completes failures with only a sanitized code and fixed message", async () => {
  const rpcCalls = [];
  const rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "get_service_titan_connection_worker_context") return rpcResult(context());
    return rpcResult(true);
  };
  const providerSecret = "provider-payload-secret-never-store";
  await assert.rejects(
    runBusinessUnitDiscovery({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      rpc,
      resolveCredentials: async () => ({ ...CREDENTIALS, clientSecret: providerSecret }),
      fetchImpl: async () => jsonResponse({ rawProviderError: providerSecret }, 401),
      sleep: async () => {},
    }),
    (error) => error instanceof DiscoveryError && error.code === "oauth_http_401",
  );
  const completion = rpcCalls.at(-1);
  assert.equal(completion.name, "complete_service_titan_business_unit_discovery");
  assert.equal(completion.args.p_inventory, null);
  assert.equal(completion.args.p_error_code, "oauth_http_401");
  assert.equal(completion.args.p_error_message, "ServiceTitan discovery failed. Review trusted worker diagnostics using the error code.");
  assert.equal(JSON.stringify(completion.args).includes(providerSecret), false);
  assert.equal(JSON.stringify(completion.args).includes("rawProviderError"), false);
});

test("approved Vault credential resolution uses the existing ready-connection ingestion purpose", async () => {
  const rpcCalls = [];
  const supabase = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return rpcResult(JSON.stringify(CREDENTIALS));
    },
  };
  const credentials = await resolveDiscoveryCredentials(context({
    secretReference: "supabase-vault://60000000-0000-4000-8000-000000000006",
  }), supabase, {});
  assert.deepEqual(credentials, CREDENTIALS);
  assert.deepEqual(rpcCalls, [{
    name: "resolve_service_titan_connection_secret",
    args: {
      p_organization_id: ORGANIZATION_ID,
      p_connection_id: CONNECTION_ID,
      p_purpose: "ingestion",
    },
  }]);
});
