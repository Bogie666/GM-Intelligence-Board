"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SELECTED_TENANT_COOKIE } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateUuid } from "@/lib/tenant-context";

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
