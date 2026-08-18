import { NextResponse, type NextRequest } from "next/server";
import { getAppConfig } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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

  return NextResponse.redirect(new URL(config.isDemo ? "/" : "/login", request.url), 303);
}
