#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseCredentialPayload } from "./lib/servicetitan-report.mjs";
import {
  DiscoveryError,
  runBusinessUnitDiscovery,
} from "./lib/servicetitan-business-unit-discovery.mjs";

const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GCP_REFERENCE = /^gcp-secret:\/\/(projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}\/versions\/(?:latest|[1-9][0-9]*))$/;
const ENV_REFERENCE = /^env:\/\/([A-Z][A-Z0-9_]{1,127})$/;
const VAULT_REFERENCE = /^supabase-vault:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const HELP = `Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  node scripts/discover-servicetitan-business-units.mjs \\
    --organization-id ORGANIZATION_UUID \\
    --connection-id CONNECTION_UUID \\
    --confirm ORGANIZATION_UUID:CONNECTION_UUID

Processes the oldest requested discovery run for the exact ready ServiceTitan connection. The
worker obtains its configuration revision through the governed worker-context RPC, resolves the
approved managed credential in memory, reads a bounded complete business-unit inventory, and
starts/completes the run through compare-and-set RPCs. It never logs credentials, access tokens,
provider response bodies, or raw provider errors.`;

function parseArgs(argv) {
  const allowed = new Set(["organization-id", "connection-id", "confirm"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new DiscoveryError("argument_invalid", "An unexpected argument was provided.");
    const name = token.slice(2);
    if (!allowed.has(name)) throw new DiscoveryError("argument_invalid", "An unknown option was provided.");
    if (values[name] !== undefined) throw new DiscoveryError("argument_invalid", "A duplicate option was provided.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new DiscoveryError("argument_invalid", "An option value is missing.");
    values[name] = value;
    index += 1;
  }
  return values;
}

function validateIdentity(args) {
  const organizationId = args["organization-id"];
  const connectionId = args["connection-id"];
  if (!UUID_PATTERN.test(organizationId || "") || !UUID_PATTERN.test(connectionId || "")) {
    throw new DiscoveryError("identity_invalid", "Organization and connection IDs must be canonical UUIDs.");
  }
  if (args.confirm !== `${organizationId}:${connectionId}`) {
    throw new DiscoveryError("confirmation_invalid", "--confirm must exactly match ORGANIZATION_UUID:CONNECTION_UUID.");
  }
  return { organizationId, connectionId };
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new DiscoveryError("environment_missing", "Required worker environment is unavailable.");
  return value;
}

function validateSupabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DiscoveryError("environment_invalid", "The Supabase URL is invalid.");
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new DiscoveryError("environment_invalid", "The Supabase URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DiscoveryError("environment_invalid", "The Supabase URL contains unsupported components.");
  }
  return url.origin;
}

export async function resolveDiscoveryCredentials(connection, supabase, environment = process.env) {
  const reference = connection.secretReference;
  const envMatch = reference.match(ENV_REFERENCE);
  let raw;
  if (envMatch) {
    raw = environment[envMatch[1]];
    if (!raw) throw new DiscoveryError("credential_unavailable", "The managed environment credential is unavailable.");
  } else {
    const gcpMatch = reference.match(GCP_REFERENCE);
    if (gcpMatch) {
      const binary = environment.GCLOUD_BIN?.trim() || "gcloud";
      try {
        ({ stdout: raw } = await execFileAsync(binary, ["secrets", "versions", "access", gcpMatch[1]], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        }));
      } catch {
        throw new DiscoveryError("credential_unavailable", "The approved managed credential is unavailable.");
      }
    } else if (VAULT_REFERENCE.test(reference)) {
      // The existing resolver governs ready-connection credential reads under its ingestion
      // purpose. Discovery is also a read-only operation against a ready connection.
      const { data, error } = await supabase.rpc("resolve_service_titan_connection_secret", {
        p_organization_id: connection.organizationId,
        p_connection_id: connection.id,
        p_purpose: "ingestion",
      });
      if (error || typeof data !== "string" || !data) {
        throw new DiscoveryError("credential_unavailable", "The approved managed credential is unavailable.");
      }
      raw = data;
    } else {
      throw new DiscoveryError("credential_reference_unsupported", "The managed credential reference is unsupported.");
    }
  }

  try {
    return parseCredentialPayload(raw);
  } catch {
    throw new DiscoveryError("credential_invalid", "The managed credential payload is invalid.");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  const input = validateIdentity(args);
  const supabaseUrl = validateSupabaseUrl(requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"));
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const result = await runBusinessUnitDiscovery({
    ...input,
    rpc: (name, payload) => supabase.rpc(name, payload),
    resolveCredentials: (connection) => resolveDiscoveryCredentials(connection, supabase),
  });
  console.log("ServiceTitan business-unit discovery completed.");
  console.log(`Organization ID: ${input.organizationId}`);
  console.log(`Connection ID: ${input.connectionId}`);
  console.log(`Discovery run ID: ${result.discoveryRunId}`);
  console.log(`Business units: ${result.businessUnitCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof DiscoveryError ? error.code : "discovery_unexpected";
    console.error(`ServiceTitan business-unit discovery failed (${code}).`);
    process.exitCode = 1;
  });
}
