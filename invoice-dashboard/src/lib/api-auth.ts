import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// ---------------------------------------------------------------------------
// Shared API-route authentication helpers
// ---------------------------------------------------------------------------

export interface AuthSuccess {
  userId: string;
  email: string;
  role: string | undefined;
}

type AuthResult =
  | AuthSuccess
  | { error: NextResponse };

/**
 * Validate Supabase session from cookies.
 * Returns the authenticated user or a 401 response.
 */
export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { error: NextResponse.json({ error: "Server misconfiguration" }, { status: 500 }) };
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll() {
        // Read-only in API routes — no-op
      },
    },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const role =
    (user.app_metadata?.role as string | undefined) ??
    (user.user_metadata?.role as string | undefined);

  return { userId: user.id, email: user.email ?? "", role };
}

/**
 * Validate Supabase session AND require admin role.
 * Returns the authenticated admin user or a 401/403 response.
 */
export async function requireAdmin(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth;

  if (auth.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return auth;
}

// ---------------------------------------------------------------------------
// In-memory rate limiter (per-user, sliding window)
//
// Note: on Vercel serverless, each cold-start gets a fresh map. This means
// rate limiting is per-instance, not global. For this internal dashboard with
// a small number of users this is acceptable. If stricter enforcement is
// needed, swap to Vercel KV or Upstash Redis.
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, number[]>();
let lastCleanup = Date.now();

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;
const MAX_ENTRIES = 1000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

function cleanupStaleEntries(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS && rateLimitMap.size < MAX_ENTRIES) return;
  lastCleanup = now;

  for (const [key, timestamps] of rateLimitMap) {
    const recent = timestamps.filter((t) => now - t < windowMs);
    if (recent.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, recent);
    }
  }
}

export function isRateLimited(
  userId: string,
  maxRequests = DEFAULT_MAX,
  windowMs = DEFAULT_WINDOW_MS,
): boolean {
  cleanupStaleEntries(windowMs);

  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);

  if (recent.length >= maxRequests) {
    rateLimitMap.set(userId, recent);
    return true;
  }

  recent.push(now);
  rateLimitMap.set(userId, recent);
  return false;
}

/**
 * Type guard: returns true when auth succeeded (no error).
 */
export function isAuthed(auth: AuthResult): auth is AuthSuccess {
  return !("error" in auth);
}
