import { NextResponse, type NextRequest } from "next/server";
import { getSafeRedirectPath } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const config = getAppConfig();
  if (config.isDemo) return NextResponse.redirect(new URL("/", request.url));

  const code = request.nextUrl.searchParams.get("code");
  const nextPath = getSafeRedirectPath(request.nextUrl.searchParams.get("next"));
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=callback", request.url));
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/login?error=callback", request.url));
  }

  return NextResponse.redirect(new URL(nextPath, request.url));
}
