import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const ORGANIZATION_ROLES = [
  "owner",
  "admin",
  "brand_executive",
  "general_manager",
  "department_leader",
  "viewer",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export interface MembershipCandidate {
  organization_id: unknown;
  role: unknown;
  status: unknown;
  organizations: { status?: unknown } | Array<{ status?: unknown }> | null;
}

export interface TenantMembership {
  organizationId: string;
  role: OrganizationRole;
}

export type MembershipResolution =
  | { ok: true; membership: TenantMembership }
  | {
      ok: false;
      reason: "no-active-membership" | "ambiguous-active-memberships" | "invalid-membership";
    };

export type TenantAuthContext =
  | {
      ok: true;
      user: User;
      membership: TenantMembership;
      supabase: SupabaseClient;
    }
  | {
      ok: false;
      reason:
        | "unauthenticated"
        | "membership-query-failed"
        | "no-active-membership"
        | "ambiguous-active-memberships"
        | "invalid-membership";
    };

export function isAdminRole(role: unknown): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

function isOrganizationRole(role: unknown): role is OrganizationRole {
  return typeof role === "string" && ORGANIZATION_ROLES.includes(role as OrganizationRole);
}

function organizationIsActive(
  organization: MembershipCandidate["organizations"],
): boolean {
  if (Array.isArray(organization)) {
    return organization.length === 1 && organization[0]?.status === "active";
  }
  return organization?.status === "active";
}

export function resolveActiveMembership(
  memberships: readonly MembershipCandidate[],
): MembershipResolution {
  const active = memberships.filter(
    (membership) =>
      membership.status === "active" && organizationIsActive(membership.organizations),
  );

  if (active.length === 0) return { ok: false, reason: "no-active-membership" };
  if (active.length > 1) return { ok: false, reason: "ambiguous-active-memberships" };

  const membership = active[0];
  if (
    typeof membership.organization_id !== "string" ||
    membership.organization_id.length === 0 ||
    !isOrganizationRole(membership.role)
  ) {
    return { ok: false, reason: "invalid-membership" };
  }

  return {
    ok: true,
    membership: {
      organizationId: membership.organization_id,
      role: membership.role,
    },
  };
}

export function getSafeRedirectPath(
  candidate: string | null | undefined,
  fallback = "/",
): string {
  if (!candidate || !candidate.startsWith("/") || candidate.includes("\\")) return fallback;

  try {
    const base = new URL("https://application.invalid");
    const destination = new URL(candidate, base);
    if (destination.origin !== base.origin) return fallback;
    if (destination.pathname === "/login" || destination.pathname.startsWith("/auth/")) {
      return fallback;
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

export async function getTenantAuthContext(): Promise<TenantAuthContext> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) return { ok: false, reason: "unauthenticated" };

  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role, status, organizations!inner(status)")
    .eq("profile_id", user.id)
    .eq("status", "active")
    .eq("organizations.status", "active")
    .limit(2);

  if (error || !data) return { ok: false, reason: "membership-query-failed" };

  const resolution = resolveActiveMembership(data as unknown as MembershipCandidate[]);
  if (resolution.ok === false) return { ok: false, reason: resolution.reason };

  return {
    ok: true,
    user,
    membership: resolution.membership,
    supabase,
  };
}
