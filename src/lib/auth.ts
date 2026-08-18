import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const SELECTED_TENANT_COOKIE = "gm-selected-tenant";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ORGANIZATION_ROLES = [
  "owner",
  "admin",
  "brand_executive",
  "general_manager",
  "department_leader",
  "viewer",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

interface OrganizationCandidate {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  status?: unknown;
}

export interface MembershipCandidate {
  organization_id: unknown;
  role: unknown;
  status: unknown;
  organizations: OrganizationCandidate | OrganizationCandidate[] | null;
}

export interface TenantMembership {
  organizationId: string;
  role: OrganizationRole;
}

export interface TenantAccessOption extends TenantMembership {
  slug: string;
  name: string;
}

export type MembershipResolution =
  | { ok: true; membership: TenantMembership; availableTenants: TenantAccessOption[] }
  | {
      ok: false;
      reason: "no-active-membership" | "tenant-selection-required" | "invalid-membership";
      availableTenants?: TenantAccessOption[];
    };

export type TenantAuthContext =
  | {
      ok: true;
      user: User;
      membership: TenantMembership;
      availableTenants: TenantAccessOption[];
      supabase: SupabaseClient;
    }
  | {
      ok: false;
      reason:
        | "unauthenticated"
        | "membership-query-failed"
        | "no-active-membership"
        | "tenant-selection-required"
        | "invalid-membership";
      availableTenants?: TenantAccessOption[];
    };

export function isAdminRole(role: unknown): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

function isOrganizationRole(role: unknown): role is OrganizationRole {
  return typeof role === "string" && ORGANIZATION_ROLES.includes(role as OrganizationRole);
}

function organizationRecord(organization: MembershipCandidate["organizations"]): OrganizationCandidate | null {
  if (Array.isArray(organization)) return organization.length === 1 ? organization[0] ?? null : null;
  return organization;
}

export function resolveActiveMembership(
  memberships: readonly MembershipCandidate[],
  selectedOrganizationId?: string | null,
): MembershipResolution {
  const active = memberships.filter(
    (membership) => membership.status === "active" && organizationRecord(membership.organizations)?.status === "active",
  );
  if (active.length === 0) return { ok: false, reason: "no-active-membership" };

  const options = active.map((membership): TenantAccessOption | null => {
    const organization = organizationRecord(membership.organizations);
    if (
      typeof membership.organization_id !== "string" || !UUID_PATTERN.test(membership.organization_id) ||
      !isOrganizationRole(membership.role) || organization?.id !== membership.organization_id ||
      typeof organization.slug !== "string" || organization.slug.length === 0 ||
      typeof organization.name !== "string" || organization.name.length === 0
    ) return null;
    return {
      organizationId: membership.organization_id,
      role: membership.role,
      slug: organization.slug,
      name: organization.name,
    };
  });
  if (options.some((option) => option === null)) return { ok: false, reason: "invalid-membership" };

  const availableTenants = (options as TenantAccessOption[]).sort(
    (left, right) => left.name.localeCompare(right.name) || left.organizationId.localeCompare(right.organizationId),
  );
  const selected = availableTenants.length === 1
    ? availableTenants[0]
    : availableTenants.find((tenant) => tenant.organizationId === selectedOrganizationId);
  if (!selected) return { ok: false, reason: "tenant-selection-required", availableTenants };

  return {
    ok: true,
    membership: { organizationId: selected.organizationId, role: selected.role },
    availableTenants,
  };
}

export function getSafeRedirectPath(candidate: string | null | undefined, fallback = "/"): string {
  if (!candidate || !candidate.startsWith("/") || candidate.includes("\\")) return fallback;
  try {
    const base = new URL("https://application.invalid");
    const destination = new URL(candidate, base);
    if (destination.origin !== base.origin) return fallback;
    if (destination.pathname === "/login" || destination.pathname.startsWith("/auth/")) return fallback;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

export async function getTenantAuthContext(): Promise<TenantAuthContext> {
  const supabase = await createServerSupabaseClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false, reason: "unauthenticated" };

  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role, status, organizations!inner(id, slug, name, status)")
    .eq("profile_id", user.id)
    .eq("status", "active")
    .eq("organizations.status", "active");
  if (error || !data) return { ok: false, reason: "membership-query-failed" };

  const cookieStore = await cookies();
  const selectedTenant = cookieStore.get(SELECTED_TENANT_COOKIE)?.value ?? null;
  const resolution = resolveActiveMembership(data as unknown as MembershipCandidate[], selectedTenant);
  if (resolution.ok === false) {
    return { ok: false, reason: resolution.reason, availableTenants: resolution.availableTenants };
  }

  return {
    ok: true,
    user,
    membership: resolution.membership,
    availableTenants: resolution.availableTenants,
    supabase,
  };
}
