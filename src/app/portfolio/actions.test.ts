import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  origin: "https://portfolio.example.com",
  host: "portfolio.example.com",
  isDemo: false,
  user: { id: "22222222-2222-4222-8222-222222222222" } as { id: string } | null,
  rpc: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  cookieSet: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: mocks.origin, host: mocks.host }),
  cookies: async () => ({ set: mocks.cookieSet, get: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/env", () => ({ getAppConfig: () => ({ isDemo: mocks.isDemo, mode: "production" }) }));
vi.mock("@/lib/auth", () => ({ SELECTED_TENANT_COOKIE: "gm-selected-tenant" }));
vi.mock("@/lib/tenant-context", () => ({
  validateUuid: (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: mocks.user ? null : { message: "no session" } }) },
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  }),
}));

import { createPortfolioBrandOrganizationAction } from "./actions";

const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const INITIAL = { status: "idle" as const, message: "" };

function form(values: Record<string, string>) {
  const data = new FormData();
  Object.entries(values).forEach(([key, value]) => data.set(key, value));
  return data;
}

function validForm() {
  return form({
    organizationName: "Service Wizards",
    organizationSlug: "service-wizards",
    confirmSlug: "service-wizards",
  });
}

function mockOwnerGate(owner: boolean) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "is_portfolio_owner") return { data: owner, error: null };
    if (name === "create_portfolio_brand_organization") {
      return { data: [{ organization_id: ORGANIZATION_ID, membership_id: ORGANIZATION_ID, attachment_id: ORGANIZATION_ID }], error: null };
    }
    if (name === "can_access_portfolio_brand") return { data: true, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.origin = "https://portfolio.example.com";
  mocks.host = "portfolio.example.com";
  mocks.isDemo = false;
  mocks.user = { id: "22222222-2222-4222-8222-222222222222" };
  mockOwnerGate(true);
});

describe("createPortfolioBrandOrganizationAction", () => {
  it("rejects cross-origin requests before any database call", async () => {
    mocks.origin = "https://evil.example.net";
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(state.message).toContain("origin");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects demo mode before any database call", async () => {
    mocks.isDemo = true;
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated sessions", async () => {
    mocks.user = null;
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects callers who are not the portfolio owner without attempting creation", async () => {
    mockOwnerGate(false);
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(state.message).toContain("portfolio owner");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("is_portfolio_owner");
  });

  it("fails closed when the owner gate itself errors", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "is_portfolio_owner" ? { data: null, error: { message: "boom" } } : { data: null, error: null });
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("returns field errors for an invalid slug without calling the creation RPC", async () => {
    const state = await createPortfolioBrandOrganizationAction(
      INITIAL,
      form({ organizationName: "Service Wizards", organizationSlug: "Bad Slug!", confirmSlug: "Bad Slug!" }),
    );
    expect(state.status).toBe("error");
    expect(state.fieldErrors?.organizationSlug).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("is_portfolio_owner");
  });

  it("requires the confirmation field to match the slug exactly", async () => {
    const state = await createPortfolioBrandOrganizationAction(
      INITIAL,
      form({ organizationName: "Service Wizards", organizationSlug: "service-wizards", confirmSlug: "service-wizard" }),
    );
    expect(state.status).toBe("error");
    expect(state.fieldErrors?.confirmSlug).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("returns a duplicate-slug field error for database code 23505", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "is_portfolio_owner") return { data: true, error: null };
      return { data: null, error: { code: "23505", message: "duplicate" } };
    });
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(state.fieldErrors?.organizationSlug).toBeTruthy();
  });

  it("maps database authorization denials to the owner-only message", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "is_portfolio_owner") return { data: true, error: null };
      return { data: null, error: { code: "42501", message: "denied" } };
    });
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(state.message).toContain("portfolio owner");
  });

  it("does not report success when the database returns no organization identifier", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "is_portfolio_owner") return { data: true, error: null };
      if (name === "create_portfolio_brand_organization") return { data: [], error: null };
      return { data: true, error: null };
    });
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("error");
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("creates the organization, selects it, and redirects to its Admin Center", async () => {
    await expect(createPortfolioBrandOrganizationAction(INITIAL, validForm())).rejects.toThrow(
      "REDIRECT:/admin?section=organization",
    );
    expect(mocks.rpc).toHaveBeenCalledWith("create_portfolio_brand_organization", {
      p_organization_slug: "service-wizards",
      p_organization_name: "Service Wizards",
    });
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "gm-selected-tenant",
      ORGANIZATION_ID,
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax" }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/portfolio");
  });

  it("normalizes the slug and name before creation", async () => {
    await expect(
      createPortfolioBrandOrganizationAction(
        INITIAL,
        form({ organizationName: "  Service Wizards  ", organizationSlug: "  SERVICE-WIZARDS ", confirmSlug: "Service-Wizards" }),
      ),
    ).rejects.toThrow("REDIRECT:/admin?section=organization");
    expect(mocks.rpc).toHaveBeenCalledWith("create_portfolio_brand_organization", {
      p_organization_slug: "service-wizards",
      p_organization_name: "Service Wizards",
    });
  });

  it("reports success without tenant selection when brand access verification is unavailable", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "is_portfolio_owner") return { data: true, error: null };
      if (name === "create_portfolio_brand_organization") {
        return { data: [{ organization_id: ORGANIZATION_ID }], error: null };
      }
      if (name === "can_access_portfolio_brand") return { data: null, error: { message: "unavailable" } };
      return { data: null, error: null };
    });
    const state = await createPortfolioBrandOrganizationAction(INITIAL, validForm());
    expect(state.status).toBe("success");
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
