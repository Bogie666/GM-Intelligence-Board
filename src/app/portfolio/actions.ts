"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SELECTED_TENANT_COOKIE } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateUuid } from "@/lib/tenant-context";

const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface PortfolioActionState {
  status: "idle" | "success" | "error";
  message: string;
  fieldErrors?: Record<string, string>;
}

function failure(message: string, fieldErrors?: Record<string, string>): PortfolioActionState {
  return { status: "error", message, ...(fieldErrors ? { fieldErrors } : {}) };
}

async function hasValidOrigin(): Promise<boolean> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export async function openPortfolioBrandAction(formData: FormData): Promise<void> {
  if (!(await hasValidOrigin())) throw new Error("The request origin could not be verified.");
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || !validateUuid(organizationId)) {
    throw new Error("The selected brand is invalid.");
  }

  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) redirect("/login?next=%2Fportfolio");

  const { data: permitted, error } = await supabase.rpc("can_access_portfolio_brand", {
    p_organization_id: organizationId,
  });
  if (error || permitted !== true) throw new Error("The selected brand is not available to this portfolio account.");

  const store = await cookies();
  store.set(SELECTED_TENANT_COOKIE, organizationId, {
    httpOnly: true,
    secure: getAppConfig().mode === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  redirect("/");
}

/**
 * Portfolio-owner-only brand onboarding. Every guard here is advisory UX; the
 * authoritative boundary is the security-definer RPC, which independently
 * verifies that the caller holds exactly one active portfolio membership with
 * the owner role before any write happens.
 */
export async function createPortfolioBrandOrganizationAction(
  _previousState: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  if (!(await hasValidOrigin())) return failure("The request origin could not be verified.");
  if (getAppConfig().isDemo) return failure("Demo mode does not create organizations.");

  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return failure("Your authenticated session could not be verified.");

  const { data: ownerGate, error: ownerGateError } = await supabase.rpc("is_portfolio_owner");
  if (ownerGateError || ownerGate !== true) {
    return failure("Only the portfolio owner can create brand organizations.");
  }

  const rawName = formData.get("organizationName");
  const rawSlug = formData.get("organizationSlug");
  const rawConfirm = formData.get("confirmSlug");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const slug = typeof rawSlug === "string" ? rawSlug.trim().toLowerCase() : "";
  const confirm = typeof rawConfirm === "string" ? rawConfirm.trim().toLowerCase() : "";

  const fieldErrors: Record<string, string> = {};
  if (name.length < 2 || name.length > 160) {
    fieldErrors.organizationName = "Enter the brand name using 2 to 160 characters.";
  }
  if (!ORGANIZATION_SLUG_PATTERN.test(slug)) {
    fieldErrors.organizationSlug = "Use 3-64 lowercase letters, numbers, or hyphens, starting and ending with a letter or number.";
  }
  if (!fieldErrors.organizationSlug && confirm !== slug) {
    fieldErrors.confirmSlug = "Retype the workspace URL key exactly to confirm this new organization.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return failure("Correct the highlighted fields to create the organization.", fieldErrors);
  }

  const { data, error } = await supabase.rpc("create_portfolio_brand_organization", {
    p_organization_slug: slug,
    p_organization_name: name,
  });
  if (error) {
    if (error.code === "23505") {
      return failure("That workspace URL key is already in use by another organization.", {
        organizationSlug: "Choose a different workspace URL key.",
      });
    }
    if (error.code === "42501") {
      return failure("Only the portfolio owner can create brand organizations.");
    }
    return failure("The organization could not be created by the governed database. No success is being reported.");
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const created = rows[0] as { organization_id?: unknown } | undefined;
  const organizationId = typeof created?.organization_id === "string" ? created.organization_id : "";
  if (!validateUuid(organizationId)) {
    return failure("The database did not confirm the new organization. Verify the portfolio before retrying.");
  }

  const { data: permitted, error: accessError } = await supabase.rpc("can_access_portfolio_brand", {
    p_organization_id: organizationId,
  });
  if (accessError || permitted !== true) {
    revalidatePath("/portfolio");
    return {
      status: "success",
      message: `${name} was created and attached to the portfolio. Open it from the brand list to begin setup.`,
    };
  }

  const store = await cookies();
  store.set(SELECTED_TENANT_COOKIE, organizationId, {
    httpOnly: true,
    secure: getAppConfig().mode === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  revalidatePath("/portfolio");
  revalidatePath("/");
  redirect("/admin?section=organization");
}
