import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface ServiceRoleEnvironment {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export class ServiceRoleConfigurationError extends Error {
  constructor() {
    super("Trusted ServiceTitan execution is not configured.");
    this.name = "ServiceRoleConfigurationError";
  }
}

export function validateServiceRoleEnvironment(environment: ServiceRoleEnvironment): {
  url: string;
  serviceRoleKey: string;
} {
  const rawUrl = environment.SUPABASE_URL?.trim() ?? "";
  const publicRawUrl = environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
    const publicUrl = new URL(publicRawUrl);
    if (publicUrl.origin !== url.origin) throw new ServiceRoleConfigurationError();
  } catch {
    throw new ServiceRoleConfigurationError();
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ServiceRoleConfigurationError();
  }
  if (serviceRoleKey.length < 20 || /\s/.test(serviceRoleKey)) {
    throw new ServiceRoleConfigurationError();
  }
  if (!serviceRoleKey.startsWith("sb_secret_")) {
    const parts = serviceRoleKey.split(".");
    if (parts.length !== 3) throw new ServiceRoleConfigurationError();
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
      if (payload.role !== "service_role") throw new ServiceRoleConfigurationError();
    } catch (error) {
      if (error instanceof ServiceRoleConfigurationError) throw error;
      throw new ServiceRoleConfigurationError();
    }
  }
  return { url: url.origin, serviceRoleKey };
}

export function createServiceRoleSupabaseClient(
  environment: ServiceRoleEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  clientFactory: typeof createClient = createClient,
): SupabaseClient {
  const config = validateServiceRoleEnvironment(environment);
  return clientFactory(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
