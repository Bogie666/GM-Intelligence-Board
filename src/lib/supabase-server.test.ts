import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc })),
}));

const EXPECTED = "20260819001700_tenant_managed_divisions";

function rpcResult(data: unknown, error: unknown = null) {
  return { abortSignal: vi.fn().mockResolvedValue({ data, error }) };
}

describe("database release health", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it("accepts only the division-native schema-017 readiness contract", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
    rpc.mockReturnValue(rpcResult([{ ready: true, release_marker: EXPECTED }]));

    const { checkDatabaseHealth } = await import("./supabase-server");
    const health = await checkDatabaseHealth();

    expect(health.schemaReady).toBe(true);
    expect(health.releaseMarker).toBe(EXPECTED);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_division_release_readiness");
  });

  it("fails closed when schema-017 readiness is missing instead of accepting legacy schema 016", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
    rpc.mockReturnValue(rpcResult(null, { code: "PGRST202" }));

    const { checkDatabaseHealth } = await import("./supabase-server");
    const health = await checkDatabaseHealth();

    expect(health.schemaReady).toBe(false);
    expect(health.reachable).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("get_release_readiness");
  });

  it("rejects a ready legacy marker returned from the new RPC", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
    rpc.mockReturnValue(rpcResult([{ ready: true, release_marker: "20260819001600_enterprise_admin_hardening" }]));

    const { checkDatabaseHealth } = await import("./supabase-server");
    const health = await checkDatabaseHealth();

    expect(health.reachable).toBe(true);
    expect(health.schemaReady).toBe(false);
  });
});
