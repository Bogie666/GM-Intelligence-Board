#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GCP_REFERENCE = /^gcp-secret:\/\/(projects\/[A-Za-z0-9._-]+\/secrets\/[A-Za-z0-9._-]+\/versions\/[A-Za-z0-9._-]+)$/;
const ENV_REFERENCE = /^env:\/\/([A-Z][A-Z0-9_]{1,127})$/;
const VAULT_REFERENCE = /^supabase-vault:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const HELP = `Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  node scripts/validate-servicetitan-connection.mjs \\
    --organization-id 00000000-0000-0000-0000-000000000000 \\
    --connection-id 00000000-0000-0000-0000-000000000000 \\
    --confirm 00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000

The managed secret must contain JSON with exactly these required string fields:
  {"clientId":"...","clientSecret":"...","appKey":"..."}

Supported references:
  supabase-vault://SECRET_UUID
  gcp-secret://projects/PROJECT/secrets/SECRET/versions/VERSION
  env://UPPERCASE_ENVIRONMENT_VARIABLE

This operator-only probe obtains an OAuth token in memory, performs one read-only ServiceTitan
business-units request, and marks the database connection ready only after both calls pass. It
never prints the secret, app key, OAuth token, or response body.`;

function fail(message) {
  console.error(`ServiceTitan validation failed: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const allowed = new Set(["organization-id", "connection-id", "confirm"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
    if (values[name] !== undefined) throw new Error(`duplicate option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a valid URL");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Supabase URL must use HTTPS (HTTP is accepted only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Supabase URL must not contain credentials, query parameters, or a fragment");
  }
  return url.origin;
}

function validateServiceRoleKey(key) {
  if (!key || key.length < 20 || /\s/.test(key)) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing or malformed");
  if (key.startsWith("sb_secret_")) return key;
  const parts = key.split(".");
  if (parts.length !== 3) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a service-role key");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is malformed");
  }
  if (payload.role !== "service_role") throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a service-role key");
  return key;
}

function validateInputs(args) {
  const organizationId = args["organization-id"];
  const connectionId = args["connection-id"];
  if (!UUID.test(organizationId ?? "")) throw new Error("organization ID is invalid");
  if (!UUID.test(connectionId ?? "")) throw new Error("connection ID is invalid");
  if (args.confirm !== `${organizationId}:${connectionId}`) {
    throw new Error("--confirm must exactly match ORGANIZATION_ID:CONNECTION_ID");
  }
  return { organizationId, connectionId };
}

function parseCredential(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("managed secret is not valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("managed secret must be a JSON object");
  const allowed = new Set(["clientId", "clientSecret", "appKey"]);
  const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error("managed secret contains unsupported fields");
  for (const key of allowed) {
    if (typeof parsed[key] !== "string" || !parsed[key].trim() || parsed[key].length > 4096 || /\p{Cc}/u.test(parsed[key])) {
      throw new Error(`managed secret field ${key} is missing or malformed`);
    }
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, appKey: parsed.appKey };
}

async function resolveSecret(reference, client, input) {
  const envMatch = reference.match(ENV_REFERENCE);
  if (envMatch) {
    const raw = process.env[envMatch[1]];
    if (!raw) throw new Error(`managed environment variable ${envMatch[1]} is not set`);
    return parseCredential(raw);
  }

  const gcpMatch = reference.match(GCP_REFERENCE);
  if (gcpMatch) {
    const gcloud = process.env.GCLOUD_BIN || "gcloud";
    let stdout;
    try {
      ({ stdout } = await execFileAsync(gcloud, ["secrets", "versions", "access", gcpMatch[1]], {
        encoding: "utf8",
        maxBuffer: 32 * 1024,
        timeout: 30_000,
      }));
    } catch {
      throw new Error("Google Secret Manager lookup failed");
    }
    return parseCredential(stdout);
  }

  const vaultMatch = reference.match(VAULT_REFERENCE);
  if (vaultMatch) {
    const { data, error } = await client.rpc("resolve_service_titan_connection_secret", {
      p_organization_id: input.organizationId,
      p_connection_id: input.connectionId,
      p_purpose: "validation",
    });
    if (error || typeof data !== "string" || !data) {
      throw new Error("Supabase Vault lookup failed");
    }
    return parseCredential(data);
  }
  throw new Error("secret reference uses an unsupported scheme");
}

async function requestWithTimeout(url, init, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeServiceTitan(connection, credential) {
  const integration = connection.environment === "integration";
  const authOrigin = integration ? "https://auth-integration.servicetitan.io" : "https://auth.servicetitan.io";
  const apiOrigin = integration ? "https://api-integration.servicetitan.io" : "https://api.servicetitan.io";
  const tokenResponse = await requestWithTimeout(`${authOrigin}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`OAuth request returned HTTP ${tokenResponse.status}`);

  let tokenPayload;
  try {
    tokenPayload = await tokenResponse.json();
  } catch {
    throw new Error("OAuth response was not valid JSON");
  }
  if (typeof tokenPayload?.access_token !== "string" || !tokenPayload.access_token) {
    throw new Error("OAuth response did not contain an access token");
  }
  const tokenType = typeof tokenPayload.token_type === "string" && tokenPayload.token_type ? tokenPayload.token_type : "Bearer";
  const tenantId = encodeURIComponent(connection.service_titan_tenant_id);
  const resourceResponse = await requestWithTimeout(
    `${apiOrigin}/settings/v2/tenant/${tenantId}/business-units?page=1&pageSize=1&active=True`,
    {
      method: "GET",
      headers: {
        authorization: `${tokenType} ${tokenPayload.access_token}`,
        "st-app-key": credential.appKey,
        accept: "application/json",
      },
    },
  );
  if (!resourceResponse.ok) throw new Error(`business-units probe returned HTTP ${resourceResponse.status}`);
  try {
    const body = await resourceResponse.json();
    if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
      throw new Error("business-units response shape was not recognized");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("shape")) throw error;
    throw new Error("business-units response was not valid JSON");
  }
  return ["settings.business_units.read"];
}

async function setValidationState(client, input, expectedCredentialRevision, status, capabilities) {
  const succeeded = status === "ready";
  const { data, error } = await client.rpc("complete_service_titan_connection_validation", {
    p_organization_id: input.organizationId,
    p_connection_id: input.connectionId,
    p_configuration_revision: expectedCredentialRevision,
    p_succeeded: succeeded,
    p_capabilities: succeeded ? capabilities : null,
    p_error_code: succeeded ? null : "validation_failed",
  });
  if (error) throw new Error("database validation-state RPC failed");
  if (data !== true) throw new Error("connection was rotated, disabled, archived, or removed during validation");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      return;
    }
  } catch (error) {
    fail(error.message);
    console.error(HELP);
    return;
  }

  let input;
  let supabaseUrl;
  let serviceRoleKey;
  try {
    input = validateInputs(args);
    supabaseUrl = validateUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    serviceRoleKey = validateServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (error) {
    fail(error.message);
    return;
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const { data: workerContext, error: lookupError } = await client.rpc(
    "get_service_titan_connection_worker_context",
    {
      p_organization_id: input.organizationId,
      p_connection_id: input.connectionId,
      p_purpose: "validation",
    },
  );
  if (lookupError || !workerContext || typeof workerContext !== "object" || Array.isArray(workerContext)) {
    fail("database connection context lookup failed");
    return;
  }
  const connection = {
    id: workerContext.id,
    organization_id: workerContext.organizationId,
    service_titan_tenant_id: workerContext.serviceTitanTenantId,
    environment: workerContext.environment,
    secret_reference: workerContext.secretReference,
    configuration_revision: workerContext.configurationRevision,
    status: workerContext.status,
  };
  if (!UUID.test(connection.id ?? "") || connection.organization_id !== input.organizationId
      || typeof connection.service_titan_tenant_id !== "string"
      || !["production", "integration"].includes(connection.environment)
      || !UUID.test(connection.configuration_revision ?? "")) {
    fail("database connection context was malformed");
    return;
  }

  try {
    const credential = await resolveSecret(connection.secret_reference, client, input);
    const capabilities = await probeServiceTitan(connection, credential);
    await setValidationState(client, input, connection.configuration_revision, "ready", capabilities);
    console.log("ServiceTitan connection validated and marked ready.");
    console.log(`Organization ID: ${input.organizationId}`);
    console.log(`Connection ID: ${input.connectionId}`);
    console.log(`Capabilities: ${capabilities.join(", ")}`);
  } catch (error) {
    try {
      await setValidationState(client, input, connection.configuration_revision, "needs_attention", null);
    } catch {
      // Preserve the primary validation failure and avoid printing database/provider details.
    }
    fail(error instanceof Error ? error.message : "unexpected validation error");
  }
}

await main();
