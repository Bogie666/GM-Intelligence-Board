import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface DatabaseHealth {
  configured: boolean;
  reachable: boolean;
  schemaReady: boolean;
  releaseMarker?: string;
  latencyMs?: number;
  reason?: string;
}

let healthClient: SupabaseClient | undefined;
let healthClientIdentity = "";
const EXPECTED_SCHEMA_RELEASE = "20260818000900_multi_tenant_operator_access";

function publicServerEnvironment(): { url: string; anonKey: string } | undefined {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return undefined;
  return { url, anonKey };
}

/** A low-privilege client for public release-readiness checks only. */
function getHealthClient(): SupabaseClient | undefined {
  const environment = publicServerEnvironment();
  if (!environment) return undefined;

  const identity = `${environment.url}|${environment.anonKey}`;
  if (!healthClient || healthClientIdentity !== identity) {
    healthClient = createClient(environment.url, environment.anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    healthClientIdentity = identity;
  }
  return healthClient;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const client = getHealthClient();
  if (!client) {
    return {
      configured: false,
      reachable: false,
      schemaReady: false,
      reason: "Supabase public environment is not configured.",
    };
  }

  const expectedRelease = EXPECTED_SCHEMA_RELEASE;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const { data, error } = await client.rpc("get_release_readiness").abortSignal(controller.signal);
    const latencyMs = Date.now() - startedAt;
    if (error) {
      return {
        configured: true,
        reachable: false,
        schemaReady: false,
        latencyMs,
        reason: "Supabase release-readiness query failed.",
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    const releaseMarker = typeof row?.release_marker === "string" ? row.release_marker : undefined;
    const schemaReady = row?.ready === true && releaseMarker === expectedRelease;
    return {
      configured: true,
      reachable: true,
      schemaReady,
      releaseMarker,
      latencyMs,
      ...(schemaReady ? {} : { reason: "Database schema release does not match the application release." }),
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      schemaReady: false,
      latencyMs: Date.now() - startedAt,
      reason: "Supabase release-readiness query failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
