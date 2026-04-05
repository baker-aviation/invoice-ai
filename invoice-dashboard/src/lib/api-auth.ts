import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServerClient } from "@supabase/ssr";
import { getRedis } from "@/lib/redis";

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
  // Allow internal service-key auth (for cron → API calls within the same app)
  const serviceKey = req.headers.get("x-service-key");
  if (serviceKey && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (serviceKey.length === process.env.SUPABASE_SERVICE_ROLE_KEY.length &&
        timingSafeEqual(Buffer.from(serviceKey), Buffer.from(process.env.SUPABASE_SERVICE_ROLE_KEY))) {
      return { userId: "system", email: "cron@internal", role: "admin" };
    }
  }

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
// Cron secret verification (constant-time comparison)
// ---------------------------------------------------------------------------

export function verifyCronSecret(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Rate limiter — Redis-backed (global) with in-memory fallback
//
// Uses Upstash Redis sliding window when available (shared across all Vercel
// instances). Falls back to per-instance in-memory map if Redis is not
// configured, which is acceptable for small teams but not for 50+ users.
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

function isRateLimitedInMemory(
  userId: string,
  maxRequests: number,
  windowMs: number,
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

export async function isRateLimited(
  userId: string,
  maxRequests = DEFAULT_MAX,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    // Fallback to in-memory (per-instance) rate limiting
    return isRateLimitedInMemory(userId, maxRequests, windowMs);
  }

  try {
    const key = `rl:${userId}`;
    const windowSec = Math.ceil(windowMs / 1000);

    // Atomic increment + TTL via Redis
    const count = await redis.incr(key);
    if (count === 1) {
      // First request in window — set expiry
      await redis.expire(key, windowSec);
    }
    return count > maxRequests;
  } catch {
    // Redis error — fall back to in-memory
    return isRateLimitedInMemory(userId, maxRequests, windowMs);
  }
}

/**
 * Validate Supabase session AND require super_admin flag in app_metadata.
 * Only the project owner should have this flag.
 */
export async function requireSuperAdmin(req: NextRequest): Promise<AuthResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { error: NextResponse.json({ error: "Server misconfiguration" }, { status: 500 }) };
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() { return req.cookies.getAll(); },
      setAll() {},
    },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (!user.app_metadata?.super_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const role = (user.app_metadata?.role as string | undefined) ?? (user.user_metadata?.role as string | undefined);
  return { userId: user.id, email: user.email ?? "", role };
}

/**
 * Validate Supabase session AND require admin or chief_pilot role.
 */
export async function requireChiefPilotOrAdmin(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth;

  if (auth.role !== "admin" && auth.role !== "chief_pilot") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return auth;
}

/**
 * Type guard: returns true when auth succeeded (no error).
 */
export function isAuthed(auth: AuthResult): auth is AuthSuccess {
  return !("error" in auth);
}
