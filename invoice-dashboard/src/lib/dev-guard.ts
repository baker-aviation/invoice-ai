import "server-only";
import { NextRequest, NextResponse } from "next/server";

/**
 * Development safety guards.
 *
 * When DEV_READ_ONLY=true and NODE_ENV=development, all mutating API requests
 * (POST/PUT/PATCH/DELETE) are blocked with a 403 to prevent accidental writes
 * to the shared production database.
 *
 * When NODE_ENV=development (regardless of DEV_READ_ONLY), write operations
 * log a bright console warning so you know you're hitting production services.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isDev = process.env.NODE_ENV === "development";
const isReadOnly = process.env.DEV_READ_ONLY === "true";

/**
 * Call at the top of any API route handler (or in middleware) to block
 * mutating requests when DEV_READ_ONLY is enabled.
 *
 * Returns a NextResponse if the request is blocked, or null if it's allowed.
 */
export function devGuard(req: NextRequest): NextResponse | null {
  if (!isDev) return null;
  if (!MUTATING_METHODS.has(req.method)) return null;

  // Always warn on mutating requests in dev
  const pathname = req.nextUrl.pathname;
  console.warn(
    `\x1b[33m⚠  DEV → PRODUCTION WRITE: ${req.method} ${pathname}\x1b[0m`,
  );

  if (isReadOnly) {
    console.warn(
      `\x1b[31m✖  BLOCKED by DEV_READ_ONLY — set DEV_READ_ONLY=false to allow writes\x1b[0m`,
    );
    return NextResponse.json(
      {
        error: "Blocked: DEV_READ_ONLY is enabled. Mutating requests are disabled in development.",
        hint: "Set DEV_READ_ONLY=false in .env.local to allow writes.",
      },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Log a warning when dev code is about to write to a production service.
 * Call this before any Supabase insert/update/delete or Cloud Run POST.
 */
export function warnProductionWrite(service: string, operation: string): void {
  if (!isDev) return;
  console.warn(
    `\x1b[33m⚠  DEV → PRODUCTION ${service}: ${operation}\x1b[0m`,
  );
}
