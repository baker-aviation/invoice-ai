import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for server-side data fetching.
 * Bypasses RLS — use only in server components / API routes, never in client code.
 * The "server-only" import above causes a build-time error if this file is ever
 * accidentally imported from a client component.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Server misconfiguration");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
