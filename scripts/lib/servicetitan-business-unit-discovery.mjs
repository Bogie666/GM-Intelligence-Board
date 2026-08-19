const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CONTROL_PATTERN = /\p{Cc}/u;

export const BUSINESS_UNIT_PAGE_SIZE = 500;
export const MAX_BUSINESS_UNIT_PAGES = 20;
export const MAX_BUSINESS_UNITS = BUSINESS_UNIT_PAGE_SIZE * MAX_BUSINESS_UNIT_PAGES;
const TOKEN_RESPONSE_LIMIT_BYTES = 65536;
const BUSINESS_UNIT_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const FAILURE_MESSAGE = "ServiceTitan discovery failed. Review trusted worker diagnostics using the error code.";

export class DiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DiscoveryError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, { code, label, maximum, trim = true }) {
  if (typeof value !== "string") fail(code, `${label} must be a string.`);
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > maximum || CONTROL_PATTERN.test(normalized)) {
    fail(code, `${label} is malformed.`);
  }
  return normalized;
}

export function parseWorkerContext(value, organizationId, connectionId) {
  if (!isRecord(value)) fail("worker_context_invalid", "The governed worker context is invalid.");
  if (value.id !== connectionId || value.organizationId !== organizationId
      || !UUID_PATTERN.test(value.id || "") || !UUID_PATTERN.test(value.organizationId || "")
      || !UUID_PATTERN.test(value.configurationRevision || "")
      || !UUID_PATTERN.test(value.requestedDiscoveryRunId || "")
      || typeof value.serviceTitanTenantId !== "string"
      || !value.serviceTitanTenantId.trim()
      || value.serviceTitanTenantId.length > 160
      || CONTROL_PATTERN.test(value.serviceTitanTenantId)
      || !["production", "integration"].includes(value.environment)
      || !["ready", "needs_attention"].includes(value.status)
      || typeof value.secretReference !== "string"
      || !value.secretReference) {
    fail("worker_context_invalid", "The governed worker context is invalid or has no requested discovery run for an enabled connection.");
  }
  return {
    id: value.id,
    organizationId: value.organizationId,
    serviceTitanTenantId: value.serviceTitanTenantId,
    environment: value.environment,
    secretReference: value.secretReference,
    configurationRevision: value.configurationRevision,
    discoveryRunId: value.requestedDiscoveryRunId,
  };
}

function normalizeProviderId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("business_units_item_invalid", "A business-unit ID is not a safe non-negative integer.");
    }
    return String(value);
  }
  return boundedString(value, {
    code: "business_units_item_invalid",
    label: "Business-unit ID",
    maximum: 160,
  });
}

function normalizeProviderModifiedAt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 64 || CONTROL_PATTERN.test(value)) {
    fail("business_units_item_invalid", "A business-unit modified timestamp is malformed.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("business_units_item_invalid", "A business-unit modified timestamp is invalid.");
  }
  return date.toISOString();
}

export function normalizeBusinessUnit(value) {
  if (!isRecord(value)) fail("business_units_item_invalid", "A business-unit item is malformed.");
  const providerBusinessUnitId = normalizeProviderId(value.id);
  const name = boundedString(value.name, {
    code: "business_units_item_invalid",
    label: "Business-unit name",
    maximum: 240,
  });
  if (typeof value.active !== "boolean") {
    fail("business_units_item_invalid", "Business-unit active state must be boolean.");
  }
  const providerModifiedAt = normalizeProviderModifiedAt(value.modifiedOn);
  return {
    providerBusinessUnitId,
    name,
    active: value.active,
    ...(providerModifiedAt ? { providerModifiedAt } : {}),
  };
}

export function normalizeBusinessUnitPage(value, pageSize = BUSINESS_UNIT_PAGE_SIZE) {
  if (!isRecord(value) || !Array.isArray(value.data) || typeof value.hasMore !== "boolean") {
    fail("business_units_response_invalid", "ServiceTitan returned an invalid business-units response.");
  }
  if (value.data.length > pageSize || (value.hasMore && value.data.length === 0)) {
    fail("business_units_response_invalid", "ServiceTitan returned inconsistent business-units pagination.");
  }
  return { items: value.data.map(normalizeBusinessUnit), hasMore: value.hasMore };
}

async function cancelBody(response) {
  await response.body?.cancel().catch(() => {});
}

export async function readBoundedJson(response, maximumBytes, code) {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    await cancelBody(response);
    fail(code, "ServiceTitan returned an oversized JSON response.");
  }

  let text = "";
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteCount += value.byteLength;
        if (byteCount > maximumBytes) {
          await reader.cancel().catch(() => {});
          fail(code, "ServiceTitan returned an oversized JSON response.");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      fail(code, "ServiceTitan returned an oversized JSON response.");
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    fail(code, "ServiceTitan returned invalid JSON.");
  }
}

export async function fetchWithDiscoveryPolicy(url, init, operation, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maximumAttempts = options.maximumAttempts ?? 3;
  const deadlineAt = options.deadlineAt;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const remainingMs = typeof deadlineAt === "number" ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    if (remainingMs <= 0) fail(`${operation}_deadline`, `${operation} exceeded the bounded execution deadline.`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, remainingMs)));
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      if (attempt === maximumAttempts || (typeof deadlineAt === "number" && deadlineAt <= Date.now())) {
        fail(`${operation}_network`, `${operation} failed after bounded network retries.`);
      }
      const waitMs = attempt * 500;
      if (typeof deadlineAt === "number" && Date.now() + waitMs >= deadlineAt) {
        fail(`${operation}_deadline`, `${operation} exceeded the bounded execution deadline.`);
      }
      await sleep(waitMs);
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maximumAttempts) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1000, 30_000)
        : attempt * 1000;
      await cancelBody(response);
      if (typeof deadlineAt === "number" && Date.now() + waitMs >= deadlineAt) {
        fail(`${operation}_deadline`, `${operation} exceeded the bounded execution deadline.`);
      }
      await sleep(waitMs);
      continue;
    }
    await cancelBody(response);
    fail(`${operation}_http_${response.status}`, `${operation} returned a non-success response.`);
  }
  fail(`${operation}_network`, `${operation} failed.`);
}

export async function obtainServiceTitanToken(credentials, environment, options = {}) {
  if (!isRecord(credentials)
      || ["clientId", "clientSecret", "appKey"].some((key) => (
        typeof credentials[key] !== "string"
        || credentials[key].trim().length < 8
        || credentials[key].length > 4096
        || CONTROL_PATTERN.test(credentials[key])
      ))) {
    fail("credential_invalid", "The resolved credential is invalid.");
  }
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
  const payload = await readBoundedJson(response, TOKEN_RESPONSE_LIMIT_BYTES, "oauth_response_invalid");
  if (!isRecord(payload) || typeof payload.access_token !== "string"
      || payload.access_token.length < 20 || payload.access_token.length > 16_384
      || CONTROL_PATTERN.test(payload.access_token)) {
    fail("oauth_response_invalid", "ServiceTitan OAuth did not return a usable access token.");
  }
  return payload.access_token;
}

export async function discoverBusinessUnits({ credentials, token, connection }, options = {}) {
  const apiOrigin = connection.environment === "integration"
    ? "https://api-integration.servicetitan.io"
    : "https://api.servicetitan.io";
  const tenantId = encodeURIComponent(connection.serviceTitanTenantId);
  const inventory = [];
  const observedIds = new Set();

  for (let page = 1; page <= MAX_BUSINESS_UNIT_PAGES; page += 1) {
    const url = `${apiOrigin}/settings/v2/tenant/${tenantId}/business-units?page=${page}&pageSize=${BUSINESS_UNIT_PAGE_SIZE}`;
    const response = await fetchWithDiscoveryPolicy(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "ST-App-Key": credentials.appKey,
        accept: "application/json",
      },
    }, "business_units", options);
    const payload = await readBoundedJson(response, BUSINESS_UNIT_RESPONSE_LIMIT_BYTES, "business_units_response_invalid");
    const parsed = normalizeBusinessUnitPage(payload);
    for (const item of parsed.items) {
      if (observedIds.has(item.providerBusinessUnitId)) {
        fail("business_units_duplicate_id", "ServiceTitan returned a duplicate business-unit ID.");
      }
      observedIds.add(item.providerBusinessUnitId);
      inventory.push(item);
      if (inventory.length > MAX_BUSINESS_UNITS) {
        fail("business_units_limit", "ServiceTitan business-unit inventory exceeded the safety limit.");
      }
    }
    if (!parsed.hasMore) {
      return inventory.sort((left, right) => (
        left.providerBusinessUnitId < right.providerBusinessUnitId ? -1
          : left.providerBusinessUnitId > right.providerBusinessUnitId ? 1 : 0
      ));
    }
  }
  fail("business_units_page_limit", "ServiceTitan business-unit pagination exceeded the safety limit.");
}

async function governedRpc(rpc, name, args, failureCode) {
  let result;
  try {
    result = await rpc(name, args);
  } catch {
    fail(failureCode, "A governed database operation failed.");
  }
  if (!isRecord(result) || result.error) {
    fail(failureCode, "A governed database operation failed.");
  }
  return result.data;
}

function publicFailureCode(error) {
  if (error instanceof DiscoveryError && SAFE_CODE_PATTERN.test(error.code)) return error.code;
  return "discovery_unexpected";
}

export async function runBusinessUnitDiscovery({
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
    p_purpose: "discovery",
  }, "worker_context_unavailable");
  const connection = parseWorkerContext(contextValue, organizationId, connectionId);
  const identity = {
    p_organization_id: organizationId,
    p_connection_id: connectionId,
    p_discovery_run_id: connection.discoveryRunId,
    p_configuration_revision: connection.configurationRevision,
  };
  const started = await governedRpc(rpc, "start_service_titan_business_unit_discovery", identity, "discovery_start_failed");
  if (started !== true) fail("discovery_start_rejected", "The discovery run became stale or unavailable before start.");

  try {
    let credentials;
    try {
      credentials = await resolveCredentials(connection);
    } catch {
      fail("credential_unavailable", "The approved managed credential could not be resolved.");
    }
    const networkOptions = { fetchImpl, sleep, timeoutMs, maximumAttempts, deadlineAt };
    const token = await obtainServiceTitanToken(credentials, connection.environment, networkOptions);
    const inventory = await discoverBusinessUnits({ credentials, token, connection }, networkOptions);
    const completed = await governedRpc(rpc, "complete_service_titan_business_unit_discovery", {
      ...identity,
      p_inventory: inventory,
      p_error_code: null,
      p_error_message: null,
    }, "discovery_complete_failed");
    if (completed !== true) fail("discovery_complete_rejected", "The discovery run became stale or unavailable before completion.");
    return { discoveryRunId: connection.discoveryRunId, businessUnitCount: inventory.length };
  } catch (error) {
    const code = publicFailureCode(error);
    try {
      await rpc("complete_service_titan_business_unit_discovery", {
        ...identity,
        p_inventory: null,
        p_error_code: code,
        p_error_message: FAILURE_MESSAGE,
      });
    } catch {
      // Preserve the primary failure. Provider details are deliberately never persisted here.
    }
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(code, "ServiceTitan discovery failed.");
  }
}
