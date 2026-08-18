"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSafeRedirectPath, SELECTED_TENANT_COOKIE } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateUuid } from "@/lib/tenant-context";

async function hasValidRequestOrigin(): Promise<boolean> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const expectedHost = requestHeaders.get("host");
  if (!origin || !expectedHost) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === expectedHost && (
      originUrl.protocol === "https:" || originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

export async function selectTenantAction(formData: FormData): Promise<never> {
  if (!(await hasValidRequestOrigin())) throw new Error("Tenant selection request origin could not be verified.");
  const organizationIdValue = formData.get("organizationId");
  const organizationId = typeof organizationIdValue === "string" ? organizationIdValue : "";
  const nextValue = formData.get("next");
  const nextPath = getSafeRedirectPath(typeof nextValue === "string" ? nextValue : null, "/");
  const cookieStore = await cookies();

  if (!validateUuid(organizationId) || getAppConfig().isDemo) {
    cookieStore.delete(SELECTED_TENANT_COOKIE);
    redirect("/");
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    cookieStore.delete(SELECTED_TENANT_COOKIE);
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, organizations!inner(status)")
    .eq("profile_id", user.id)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .eq("organizations.status", "active")
    .maybeSingle();
  if (error || !data) {
    cookieStore.delete(SELECTED_TENANT_COOKIE);
    redirect("/");
  }

  cookieStore.set(SELECTED_TENANT_COOKIE, organizationId, {
    httpOnly: true,
    secure: getAppConfig().mode === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  redirect(nextPath);
}
