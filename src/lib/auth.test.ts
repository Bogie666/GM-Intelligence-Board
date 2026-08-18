import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));

import {
  getSafeRedirectPath,
  isAdminRole,
  resolveActiveMembership,
  type MembershipCandidate,
} from "./auth";

const activeMembership = (overrides: Partial<MembershipCandidate> = {}): MembershipCandidate => ({
  organization_id: "11111111-1111-4111-8111-111111111111",
  role: "viewer",
  status: "active",
  organizations: { id: "11111111-1111-4111-8111-111111111111", slug: "organization-one", name: "Organization One", status: "active" },
  ...overrides,
});

describe("isAdminRole", () => {
  it.each(["owner", "admin"])("allows the %s role", (role) => {
    expect(isAdminRole(role)).toBe(true);
  });

  it.each(["viewer", "general_manager", "brand_executive", "", null, undefined])(
    "rejects the %s role",
    (role) => {
      expect(isAdminRole(role)).toBe(false);
    },
  );
});

describe("getSafeRedirectPath", () => {
  it.each(["/", "/admin", "/admin?section=connections", "/reports/today#summary"])(
    "allows the same-origin path %s",
    (path) => {
      expect(getSafeRedirectPath(path)).toBe(path);
    },
  );

  it.each([
    undefined,
    "",
    "admin",
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/\\attacker.example/steal",
    "/login",
    "/auth/callback?next=/admin",
  ])("falls back for an unsafe redirect (%s)", (path) => {
    expect(getSafeRedirectPath(path, "/fallback")).toBe("/fallback");
  });
});

describe("resolveActiveMembership", () => {
  it("resolves exactly one active membership in an active organization", () => {
    expect(resolveActiveMembership([activeMembership({ role: "admin" })])).toEqual({
      ok: true,
      membership: { organizationId: "11111111-1111-4111-8111-111111111111", role: "admin" },
      availableTenants: [{ organizationId: "11111111-1111-4111-8111-111111111111", role: "admin", slug: "organization-one", name: "Organization One" }],
    });
  });

  it("rejects users without an active membership", () => {
    expect(resolveActiveMembership([])).toEqual({ ok: false, reason: "no-active-membership" });
    expect(
      resolveActiveMembership([
        activeMembership({ status: "suspended" }),
        activeMembership({ organizations: { status: "archived" } }),
      ]),
    ).toEqual({ ok: false, reason: "no-active-membership" });
  });

  it("requires an explicit selection for multiple memberships and resolves a valid selection", () => {
    const second = activeMembership({
      organization_id: "22222222-2222-4222-8222-222222222222",
      role: "owner",
      organizations: { id: "22222222-2222-4222-8222-222222222222", slug: "organization-two", name: "Organization Two", status: "active" },
    });
    const unresolved = resolveActiveMembership([activeMembership(), second]);
    expect(unresolved.ok).toBe(false);
    if (unresolved.ok === false) {
      expect(unresolved.reason).toBe("tenant-selection-required");
      expect(unresolved.availableTenants).toHaveLength(2);
    }
    expect(resolveActiveMembership([activeMembership(), second], "22222222-2222-4222-8222-222222222222")).toMatchObject({
      ok: true,
      membership: { organizationId: "22222222-2222-4222-8222-222222222222", role: "owner" },
    });
    expect(resolveActiveMembership([activeMembership(), second], "33333333-3333-4333-8333-333333333333")).toMatchObject({
      ok: false,
      reason: "tenant-selection-required",
    });
  });

  it("fails closed for malformed roles and organization relationships", () => {
    expect(resolveActiveMembership([activeMembership({ role: "superuser" })])).toEqual({
      ok: false,
      reason: "invalid-membership",
    });
    expect(resolveActiveMembership([activeMembership({ organizations: null })])).toEqual({
      ok: false,
      reason: "no-active-membership",
    });
    expect(resolveActiveMembership([activeMembership({ organizations: { id: "22222222-2222-4222-8222-222222222222", slug: "wrong", name: "Wrong", status: "active" } })])).toEqual({
      ok: false,
      reason: "invalid-membership",
    });
  });
});
