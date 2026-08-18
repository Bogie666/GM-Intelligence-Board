"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;

function getPublicSupabaseConfiguration(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    throw new Error("Supabase browser configuration is unavailable.");
  }

  return { url, anonKey };
}

export function createBrowserSupabaseClient(): SupabaseClient {
  if (!browserClient) {
    const { url, anonKey } = getPublicSupabaseConfiguration();
    browserClient = createBrowserClient(url, anonKey);
  }

  return browserClient;
}
