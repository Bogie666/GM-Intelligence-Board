import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getAppConfig } from "@/lib/env";

export async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const config = getAppConfig();
  if (config.isDemo) {
    throw new Error("An authenticated Supabase client is unavailable in demo mode.");
  }

  const cookieStore = await cookies();
  return createServerClient(config.supabase.url, config.supabase.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies. src/proxy.ts performs the refresh;
          // Route Handlers can write and will successfully execute the calls above.
        }
      },
    },
  });
}
