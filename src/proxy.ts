import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSafeRedirectPath } from "@/lib/safe-redirect";
import { getAppConfig } from "@/lib/app-config";

function withRefreshedCookies(source: NextResponse, destination: NextResponse): NextResponse {
  source.cookies.getAll().forEach((cookie) => destination.cookies.set(cookie));
  return destination;
}

function isProtectedPage(pathname: string): boolean {
  return pathname === "/" || pathname === "/admin" || pathname.startsWith("/admin/");
}

export async function proxy(request: NextRequest) {
  const config = getAppConfig();
  if (config.isDemo) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.supabase.url, config.supabase.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname, search } = request.nextUrl;

  if (!user && isProtectedPage(pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return withRefreshedCookies(response, NextResponse.redirect(loginUrl));
  }

  if (user && pathname === "/login") {
    const destination = getSafeRedirectPath(request.nextUrl.searchParams.get("next"));
    return withRefreshedCookies(
      response,
      NextResponse.redirect(new URL(destination, request.url)),
    );
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
