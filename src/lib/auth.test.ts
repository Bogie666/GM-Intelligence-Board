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
  organization_id: "organization-one",
  role: "viewer",
  status: "active",
  organizations: { status: "active" },
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
      membership: { organizationId: "organization-one", role: "admin" },
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

  it("rejects ambiguous active memberships", () => {
    expect(
      resolveActiveMembership([
        activeMembership(),
        activeMembership({ organization_id: "organization-two", role: "owner" }),
      ]),
    ).toEqual({ ok: false, reason: "ambiguous-active-memberships" });
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
  });
});
