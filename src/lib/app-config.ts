export const APP_MODES = ["demo", "staging", "production"] as const;

export type AppMode = (typeof APP_MODES)[number];

export interface AppEnvironment {
  APP_MODE?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
}

export type AppConfig =
  | { mode: "demo"; isDemo: true; supabase: null }
  | {
      mode: "staging" | "production";
      isDemo: false;
      supabase: { url: string; anonKey: string };
    };

function readValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function parseAppEnvironment(environment: AppEnvironment): AppConfig {
  const rawMode = readValue(environment.APP_MODE);
  if (!APP_MODES.includes(rawMode as AppMode)) {
    throw new Error('APP_MODE must be explicitly set to "demo", "staging", or "production".');
  }
  const mode = rawMode as AppMode;

  if (mode === "demo") {
    return { mode, isDemo: true, supabase: null };
  }

  const url = readValue(environment.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = readValue(environment.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const missing = [
    !url && "NEXT_PUBLIC_SUPABASE_URL",
    !anonKey && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required ${mode} configuration: ${missing.join(", ")}.`);
  }

  return {
    mode,
    isDemo: false,
    supabase: { url, anonKey },
  };
}

let cachedConfig: AppConfig | undefined;

export function getAppConfig(): AppConfig {
  cachedConfig ??= parseAppEnvironment({
    APP_MODE: process.env.APP_MODE,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return cachedConfig;
}
