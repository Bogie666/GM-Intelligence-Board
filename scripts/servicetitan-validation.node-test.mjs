import assert from "node:assert/strict";
import test from "node:test";
import {
  ValidationError,
  parseCredentialPayload,
  runServiceTitanConnectionValidation,
} from "./lib/servicetitan-validation.mjs";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000002";
const CONFIGURATION_REVISION = "30000000-0000-4000-8000-000000000003";
const SECRET_REFERENCE = "supabase-vault://40000000-0000-4000-8000-000000000004";
const CREDENTIALS = {
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  appKey: "application-key-value",
};
const TOKEN = "service-titan-access-token";

function context(overrides = {}) {
  return {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    serviceTitanTenantId: "tenant/123",
    environment: "integration",
    secretReference: SECRET_REFERENCE,
    configurationRevision: CONFIGURATION_REVISION,
    status: "needs_attention",
    requestedDiscoveryRunId: null,
    ...overrides,
  };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(data) {
  return { data, error: null };
}

test("validation uses governed revision-pinned RPCs and bounded read-only provider requests", async () => {
  const rpcCalls = [];
  const fetchCalls = [];
  const rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "get_service_titan_connection_worker_context") return rpcResult(context());
    return rpcResult(true);
  };
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    if (url.endsWith("/connect/token")) return response({ access_token: TOKEN, token_type: "Bearer" });
    return response({ data: [], hasMore: false, ignoredProviderMetadata: "discarded" });
  };

  const result = await runServiceTitanConnectionValidation({
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    rpc,
    resolveCredentials: async (workerContext) => {
      assert.equal(workerContext.secretReference, SECRET_REFERENCE);
      return CREDENTIALS;
    },
    fetchImpl,
    sleep: async () => {},
    timeoutMs: 50,
    maximumAttempts: 2,
    deadlineAt: Date.now() + 5_000,
  });

  assert.deepEqual(result, { capabilities: ["settings.business_units.read"] });
  assert.deepEqual(rpcCalls.map((call) => call.name), [
    "get_service_titan_connection_worker_context",
    "complete_service_titan_connection_validation",
  ]);
  assert.deepEqual(rpcCalls[0].args, {
    p_organization_id: ORGANIZATION_ID,
    p_connection_id: CONNECTION_ID,
    p_purpose: "validation",
  });
  assert.deepEqual(rpcCalls[1].args, {
    p_organization_id: ORGANIZATION_ID,
    p_connection_id: CONNECTION_ID,
    p_configuration_revision: CONFIGURATION_REVISION,
    p_succeeded: true,
    p_capabilities: ["settings.business_units.read"],
    p_error_code: null,
  });
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /^https:\/\/auth-integration\.servicetitan\.io\/connect\/token$/);
  assert.equal(fetchCalls[0].init.redirect, "error");
  assert.match(fetchCalls[1].url, /tenant\/tenant%2F123\/business-units\?page=1&pageSize=1&active=True$/);
  assert.equal(fetchCalls[1].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(fetchCalls[1].init.headers["ST-App-Key"], CREDENTIALS.appKey);
});

test("validation failure persists only a fixed safe code and never provider or credential details", async () => {
  const rpcCalls = [];
  const providerSecret = "raw-provider-secret-never-persist";
  const rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "get_service_titan_connection_worker_context") return rpcResult(context());
    return rpcResult(true);
  };

  await assert.rejects(
    runServiceTitanConnectionValidation({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      rpc,
      resolveCredentials: async () => ({ ...CREDENTIALS, clientSecret: providerSecret }),
      fetchImpl: async () => response({ rawProviderError: providerSecret }, 401),
      sleep: async () => {},
      timeoutMs: 50,
      maximumAttempts: 1,
      deadlineAt: Date.now() + 5_000,
    }),
    (error) => error instanceof ValidationError && error.code === "provider_validation_failed",
  );

  const completion = rpcCalls.at(-1);
  assert.equal(completion.name, "complete_service_titan_connection_validation");
  assert.equal(completion.args.p_succeeded, false);
  assert.equal(completion.args.p_capabilities, null);
  assert.equal(completion.args.p_error_code, "validation_failed");
  const persisted = JSON.stringify(completion.args);
  assert.equal(persisted.includes(providerSecret), false);
  assert.equal(persisted.includes("rawProviderError"), false);
});

test("validation credential parser enforces the exact bounded secret contract", () => {
  assert.deepEqual(parseCredentialPayload(JSON.stringify(CREDENTIALS)), CREDENTIALS);
  assert.throws(
    () => parseCredentialPayload(JSON.stringify({ ...CREDENTIALS, accessToken: "forbidden" })),
    ValidationError,
  );
  assert.throws(() => parseCredentialPayload("not-json"), ValidationError);
  assert.throws(
    () => parseCredentialPayload(JSON.stringify({ ...CREDENTIALS, clientSecret: " leading-space" })),
    ValidationError,
  );
});
