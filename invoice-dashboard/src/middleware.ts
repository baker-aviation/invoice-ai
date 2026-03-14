import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasAccessToPath } from "@/lib/permissions";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isDev = process.env.NODE_ENV === "development";
const isReadOnly = process.env.DEV_READ_ONLY === "true";

export async function middleware(request: NextRequest) {
  // --- Dev safety: block mutating API requests when DEV_READ_ONLY=true ---
  if (isDev && MUTATING_METHODS.has(request.method) && request.nextUrl.pathname.startsWith("/api/")) {
    console.warn(
      `\x1b[33m⚠  DEV → PRODUCTION WRITE: ${request.method} ${request.nextUrl.pathname}\x1b[0m`,
    );
    if (isReadOnly) {
      console.warn(
        `\x1b[31m✖  BLOCKED by DEV_READ_ONLY\x1b[0m`,
      );
      return NextResponse.json(
        {
          error: "Blocked: DEV_READ_ONLY is enabled. Mutating requests are disabled in development.",
          hint: "Set DEV_READ_ONLY=false in .env.local to allow writes.",
        },
        { status: 403 },
      );
    }
  }

  // CSRF: reject cross-origin state-changing requests (skip for external webhooks)
  const csrfExemptPaths = ["/api/aircraft/webhook"];
  if (MUTATING_METHODS.has(request.method) && !csrfExemptPaths.some((p) => request.nextUrl.pathname === p)) {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return NextResponse.json({ error: "Forbidden: cross-origin request" }, { status: 403 });
        }
      } catch {
        return NextResponse.json({ error: "Forbidden: invalid origin" }, { status: 403 });
      }
    }
  }

  // Public routes that handle their own auth or need no auth
  // Use exact match to prevent prefix bypass on future sub-routes
  const publicApiPaths = ["/api/agents", "/api/vans/health", "/api/vans/diagnostics", "/api/invite", "/api/aircraft/webhook"];
  if (
    publicApiPaths.some((p) => request.nextUrl.pathname === p) ||
    request.nextUrl.pathname.startsWith("/api/cron/") ||
    request.nextUrl.pathname.startsWith("/api/fuel-prices/advertised/pull-mailbox") ||
    request.nextUrl.pathname.startsWith("/api/debug/") ||
    request.nextUrl.pathname.startsWith("/api/public/form/") ||
    request.nextUrl.pathname.startsWith("/api/public/info-session") ||
    request.nextUrl.pathname.startsWith("/form/")
  ) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !request.nextUrl.pathname.startsWith("/login") && !request.nextUrl.pathname.startsWith("/auth/") && request.nextUrl.pathname !== "/invite") {
    // API routes get a 401 JSON response, not a redirect to /login
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Role-based routing for authenticated users
  if (user) {
    const role = user.app_metadata?.role as string | undefined;
    const pathname = request.nextUrl.pathname;

    // Pilot-only users can only access /pilot/*, /van/*, and /login
    if (role === "pilot") {
      if (!pathname.startsWith("/pilot") && !pathname.startsWith("/van") && !pathname.startsWith("/login") && !pathname.startsWith("/api/")) {
        const url = request.nextUrl.clone();
        url.pathname = "/pilot";
        return NextResponse.redirect(url);
      }
    }

    // Van-only users can only access /van/* and /login
    if (role === "van") {
      if (!pathname.startsWith("/van") && !pathname.startsWith("/login") && !pathname.startsWith("/api/")) {
        const vanIdMeta = user.app_metadata?.van_id ?? 1;
        const url = request.nextUrl.clone();
        url.pathname = `/van/${vanIdMeta}`;
        return NextResponse.redirect(url);
      }
    }

    // Super admin route — requires super_admin flag in app_metadata
    if (pathname.startsWith("/admin/super")) {
      if (!user.app_metadata?.super_admin) {
        const url = request.nextUrl.clone();
        url.pathname = "/";
        return NextResponse.redirect(url);
      }
    }

    // Admin-only routes — block non-admin users
    if (role !== "admin" && (pathname.startsWith("/health") || pathname.startsWith("/admin"))) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }

    // Dashboard-only users are restricted to their allowed sections
    if (role === "dashboard") {
      const permissions = user.app_metadata?.permissions as string[] | undefined;
      if (!hasAccessToPath(permissions, pathname)) {
        const url = request.nextUrl.clone();
        url.pathname = "/";
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.svg$|.*\\.ico$|.*\\.webp$).*)"],
};
