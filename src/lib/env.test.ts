import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseAppEnvironment } from "./env";

const configuredEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "publishable-anon-key",
};

describe("parseAppEnvironment", () => {
  it.each(["demo", "staging", "production"] as const)(
    "accepts the explicit %s application mode",
    (mode) => {
      const config = parseAppEnvironment({ APP_MODE: mode, ...configuredEnvironment });

      expect(config.mode).toBe(mode);
      expect(config.isDemo).toBe(mode === "demo");
    },
  );

  it("allows demo mode without Supabase configuration", () => {
    expect(parseAppEnvironment({ APP_MODE: "demo" })).toEqual({
      mode: "demo",
      isDemo: true,
      supabase: null,
    });
  });

  it.each([undefined, "", "preview", "prod"])(
    "rejects a missing or unsupported application mode (%s)",
    (mode) => {
      expect(() => parseAppEnvironment({ APP_MODE: mode })).toThrow(/APP_MODE/);
    },
  );

  it.each(["staging", "production"] as const)(
    "requires the public Supabase URL and anonymous key in %s",
    (mode) => {
      expect(() => parseAppEnvironment({ APP_MODE: mode })).toThrow(
        /NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY/,
      );
      expect(() =>
        parseAppEnvironment({
          APP_MODE: mode,
          NEXT_PUBLIC_SUPABASE_URL: configuredEnvironment.NEXT_PUBLIC_SUPABASE_URL,
        }),
      ).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    },
  );

  it("trims configured values", () => {
    const config = parseAppEnvironment({
      APP_MODE: " staging ",
      NEXT_PUBLIC_SUPABASE_URL: ` ${configuredEnvironment.NEXT_PUBLIC_SUPABASE_URL} `,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: " anonymous-key ",
    });

    expect(config).toEqual({
      mode: "staging",
      isDemo: false,
      supabase: {
        url: configuredEnvironment.NEXT_PUBLIC_SUPABASE_URL,
        anonKey: "anonymous-key",
      },
    });
  });
});
