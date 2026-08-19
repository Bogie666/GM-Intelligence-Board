import {
  DiscoveryError,
  fetchWithDiscoveryPolicy,
  readBoundedJson,
} from "./servicetitan-business-unit-discovery.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /\p{Cc}/u;
const VALIDATION_RESPONSE_LIMIT_BYTES = 256 * 1024;
const VALIDATION_CAPABILITIES = ["settings.business_units.read"];

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ValidationError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function governedRpc(rpc, name, args, code) {
  let result;
  try {
    result = await rpc(name, args);
  } catch {
    fail(code, "A governed database operation failed.");
  }
  if (!isRecord(result) || result.error) fail(code, "A governed database operation failed.");
  return result.data;
}

export function parseCredentialPayload(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("credential_invalid", "The managed credential payload is invalid.");
  }
  if (!isRecord(value)) fail("credential_invalid", "The managed credential payload is invalid.");
  const allowed = new Set(["clientId", "clientSecret", "appKey"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("credential_invalid", "The managed credential payload is invalid.");
  }
  for (const key of allowed) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key] !== value[key].trim()
        || value[key].length > 4096 || CONTROL_PATTERN.test(value[key])) {
      fail("credential_invalid", "The managed credential payload is invalid.");
    }
  }
  return { clientId: value.clientId, clientSecret: value.clientSecret, appKey: value.appKey };
}

export function parseValidationWorkerContext(value, organizationId, connectionId) {
  if (!isRecord(value)
      || value.id !== connectionId
      || value.organizationId !== organizationId
      || !UUID_PATTERN.test(value.id || "")
      || !UUID_PATTERN.test(value.organizationId || "")
      || !UUID_PATTERN.test(value.configurationRevision || "")
      || typeof value.serviceTitanTenantId !== "string"
      || !value.serviceTitanTenantId.trim()
      || value.serviceTitanTenantId.length > 160
      || CONTROL_PATTERN.test(value.serviceTitanTenantId)
      || !["production", "integration"].includes(value.environment)
      || !["ready", "needs_attention"].includes(value.status)
      || typeof value.secretReference !== "string"
      || !value.secretReference) {
    fail("worker_context_invalid", "The governed validation context is invalid.");
  }
  return {
    id: value.id,
    organizationId: value.organizationId,
    serviceTitanTenantId: value.serviceTitanTenantId,
    environment: value.environment,
    secretReference: value.secretReference,
    configurationRevision: value.configurationRevision,
  };
}

async function obtainValidationToken(credentials, environment, options) {
  const authOrigin = environment === "integration"
    ? "https://auth-integration.servicetitan.io"
    : "https://auth.servicetitan.io";
  const response = await fetchWithDiscoveryPolicy(`${authOrigin}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  }, "oauth", options);
  const payload = await readBoundedJson(response, VALIDATION_RESPONSE_LIMIT_BYTES, "oauth_response_invalid");
  if (!isRecord(payload) || typeof payload.access_token !== "string"
      || !payload.access_token || payload.access_token.length > 16_384
      || CONTROL_PATTERN.test(payload.access_token)) {
    fail("oauth_response_invalid", "ServiceTitan OAuth did not return a usable access token.");
  }
  return payload.access_token;
}

export async function probeServiceTitanConnection(connection, credentials, options = {}) {
  const parsedCredentials = parseCredentialPayload(JSON.stringify(credentials));
  let token;
  try {
    token = await obtainValidationToken(parsedCredentials, connection.environment, options);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (error instanceof DiscoveryError) fail("provider_validation_failed", "ServiceTitan validation failed.");
    fail("provider_validation_failed", "ServiceTitan validation failed.");
  }
  const apiOrigin = connection.environment === "integration"
    ? "https://api-integration.servicetitan.io"
    : "https://api.servicetitan.io";
  const tenantId = encodeURIComponent(connection.serviceTitanTenantId);
  try {
    const response = await fetchWithDiscoveryPolicy(
      `${apiOrigin}/settings/v2/tenant/${tenantId}/business-units?page=1&pageSize=1&active=True`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "ST-App-Key": parsedCredentials.appKey,
          accept: "application/json",
        },
      },
      "business_units",
      options,
    );
    const payload = await readBoundedJson(response, VALIDATION_RESPONSE_LIMIT_BYTES, "business_units_response_invalid");
    if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > 1) {
      fail("provider_validation_failed", "ServiceTitan validation failed.");
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail("provider_validation_failed", "ServiceTitan validation failed.");
  }
  return [...VALIDATION_CAPABILITIES];
}

async function completeValidation(rpc, identity, succeeded, capabilities) {
  const data = await governedRpc(rpc, "complete_service_titan_connection_validation", {
    ...identity,
    p_succeeded: succeeded,
    p_capabilities: succeeded ? capabilities : null,
    p_error_code: succeeded ? null : "validation_failed",
  }, "validation_completion_failed");
  if (data !== true) fail("validation_stale", "The connection changed while validation was running.");
}

export async function runServiceTitanConnectionValidation({
  organizationId,
  connectionId,
  rpc,
  resolveCredentials,
  fetchImpl,
  sleep,
  timeoutMs,
  maximumAttempts,
  deadlineAt,
}) {
  const contextValue = await governedRpc(rpc, "get_service_titan_connection_worker_context", {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_purpose: "validation",
  }, "worker_context_unavailable");
  const connection = parseValidationWorkerContext(contextValue, organizationId, connectionId);
  const identity = {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_configuration_revision: connection.configurationRevision,
  };

  try {
    let credentials;
    try {
      credentials = await resolveCredentials(connection);
    } catch {
      fail("credential_unavailable", "The approved managed credential could not be resolved.");
    }
    const capabilities = await probeServiceTitanConnection(connection, credentials, {
      fetchImpl,
      sleep,
      timeoutMs,
      maximumAttempts,
      deadlineAt,
    });
    await completeValidation(rpc, identity, true, capabilities);
    return { capabilities };
  } catch (error) {
    try {
      await completeValidation(rpc, identity, false, null);
    } catch {
      // Preserve the primary failure; no provider or credential details are persisted.
    }
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("validation_unexpected", "ServiceTitan validation failed.");
  }
}
