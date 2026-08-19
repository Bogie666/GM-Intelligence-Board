import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseCredentialPayload,
  runServiceTitanConnectionValidation,
  type ServiceTitanCredentials,
  type WorkerConnection,
} from "../../scripts/lib/servicetitan-validation.mjs";
import {
  runBusinessUnitDiscovery,
  type DiscoveryCredentials,
  type DiscoveryWorkerConnection,
} from "../../scripts/lib/servicetitan-business-unit-discovery.mjs";

const VAULT_REFERENCE = /^supabase-vault:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const DEFAULT_EXECUTION_BUDGET_MS = 50_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;

type WorkerOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

function serviceRoleRpc(client: SupabaseClient) {
  return async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, args);
    return { data, error };
  };
}

async function resolveVaultCredential(
  client: SupabaseClient,
  connection: WorkerConnection | DiscoveryWorkerConnection,
  purpose: "validation" | "ingestion",
): Promise<ServiceTitanCredentials | DiscoveryCredentials> {
  if (!VAULT_REFERENCE.test(connection.secretReference)) {
    throw new Error("Managed credential reference is unavailable.");
  }
  const { data, error } = await client.rpc("resolve_service_titan_connection_secret", {
    p_organization_id: connection.organizationId,
    p_connection_id: connection.id,
    p_purpose: purpose,
  });
  if (error || typeof data !== "string" || !data) {
    throw new Error("Managed credential is unavailable.");
  }
  return parseCredentialPayload(data);
}

function networkPolicy(options: WorkerOptions) {
  const now = options.now ?? Date.now;
  return {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maximumAttempts: DEFAULT_MAXIMUM_ATTEMPTS,
    deadlineAt: now() + DEFAULT_EXECUTION_BUDGET_MS,
  };
}

export async function executeServiceTitanValidation(
  client: SupabaseClient,
  organizationId: string,
  connectionId: string,
  options: WorkerOptions = {},
): Promise<{ capabilities: string[] }> {
  return runServiceTitanConnectionValidation({
    organizationId,
    connectionId,
    rpc: serviceRoleRpc(client),
    resolveCredentials: (connection) => resolveVaultCredential(client, connection, "validation"),
    ...networkPolicy(options),
  });
}

export async function executeServiceTitanBusinessUnitDiscovery(
  client: SupabaseClient,
  organizationId: string,
  connectionId: string,
  options: WorkerOptions = {},
): Promise<{ businessUnitCount: number }> {
  const result = await runBusinessUnitDiscovery({
    organizationId,
    connectionId,
    rpc: serviceRoleRpc(client),
    resolveCredentials: (connection) => resolveVaultCredential(client, connection, "ingestion"),
    ...networkPolicy(options),
  });
  // The governed run identifier and configuration revision remain worker-internal.
  return { businessUnitCount: result.businessUnitCount };
}
