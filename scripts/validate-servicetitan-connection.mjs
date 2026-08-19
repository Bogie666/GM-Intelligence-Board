#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
  parseCredentialPayload,
  runServiceTitanConnectionValidation,
} from "./lib/servicetitan-validation.mjs";

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
    --confirm 00000000-0000-0000-0000-000000000000:***

The managed secret must contain JSON with exactly these required string fields:
  {"clientId":"...","clientSecret":"...","appKey":"..."}

Supported references:
  supabase-vault://SECRET_UUID
  gcp-secret://projects/PROJECT/secrets/SECRET/versions/VERSION
  env://UPPERCASE_ENVIRONMENT_VARIABLE

This operator-only entry point uses the same governed, bounded validation core as the in-product
server action. It never prints a credential, Vault value, token, provider body, raw provider error,
or internal configuration revision.`;

function fail() {
  console.error("ServiceTitan validation failed. Review trusted worker configuration and retry.");
  process.exitCode = 1;
}

function parseArgs(argv) {
  const allowed = new Set(["organization-id", "connection-id", "confirm"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error("unexpected argument");
    const name = token.slice(2);
    if (!allowed.has(name) || values[name] !== undefined) throw new Error("invalid option");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing option value");
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
    throw new Error("invalid Supabase URL");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("invalid Supabase URL");
  if (url.username || url.password || url.search || url.hash) throw new Error("invalid Supabase URL");
  return url.origin;
}

function validateServiceRoleKey(key) {
  if (!key || key.length < 20 || /\s/.test(key)) throw new Error("invalid service-role key");
  if (key.startsWith("sb_secret_")) return key;
  const parts = key.split(".");
  if (parts.length !== 3) throw new Error("invalid service-role key");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid service-role key");
  }
  if (payload.role !== "service_role") throw new Error("invalid service-role key");
  return key;
}

function validateInputs(args) {
  const organizationId = args["organization-id"];
  const connectionId = args["connection-id"];
  if (!UUID.test(organizationId ?? "") || !UUID.test(connectionId ?? "")) throw new Error("invalid identity");
  if (args.confirm !== `${organizationId}:${connectionId}`) throw new Error("invalid confirmation");
  return { organizationId, connectionId };
}

async function resolveSecret(connection, client, input) {
  const reference = connection.secretReference;
  const envMatch = reference.match(ENV_REFERENCE);
  let raw;
  if (envMatch) {
    raw = process.env[envMatch[1]];
    if (!raw) throw new Error("credential unavailable");
  } else {
    const gcpMatch = reference.match(GCP_REFERENCE);
    if (gcpMatch) {
      try {
        ({ stdout: raw } = await execFileAsync(process.env.GCLOUD_BIN || "gcloud", [
          "secrets", "versions", "access", gcpMatch[1],
        ], { encoding: "utf8", maxBuffer: 32 * 1024, timeout: 30_000 }));
      } catch {
        throw new Error("credential unavailable");
      }
    } else if (VAULT_REFERENCE.test(reference)) {
      const { data, error } = await client.rpc("resolve_service_titan_connection_secret", {
        p_organization_id: input.organizationId,
        p_connection_id: input.connectionId,
        p_purpose: "validation",
      });
      if (error || typeof data !== "string" || !data) throw new Error("credential unavailable");
      raw = data;
    } else {
      throw new Error("credential unavailable");
    }
  }
  return parseCredentialPayload(raw);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      return;
    }
    const input = validateInputs(args);
    const supabaseUrl = validateUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const serviceRoleKey = validateServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const result = await runServiceTitanConnectionValidation({
      ...input,
      rpc: (name, payload) => client.rpc(name, payload),
      resolveCredentials: (connection) => resolveSecret(connection, client, input),
      deadlineAt: Date.now() + 120_000,
    });
    console.log("ServiceTitan connection validated and marked ready.");
    console.log(`Organization ID: ${input.organizationId}`);
    console.log(`Connection ID: ${input.connectionId}`);
    console.log(`Capabilities: ${result.capabilities.join(", ")}`);
  } catch {
    fail();
    if (args === undefined) console.error(HELP);
  }
}

await main();
