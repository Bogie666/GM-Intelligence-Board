import { NextResponse, type NextRequest } from "next/server";
import { getAppConfig } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SELECTED_TENANT_COOKIE } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ ok: false, message: "Invalid request origin." }, { status: 403 });
  }

  const config = getAppConfig();
  if (!config.isDemo) {
    const supabase = await createServerSupabaseClient();
    await supabase.auth.signOut();
  }

  const response = NextResponse.redirect(new URL(config.isDemo ? "/" : "/login", request.url), 303);
  response.cookies.delete(SELECTED_TENANT_COOKIE);
  return response;
}
