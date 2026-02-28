import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for server-side data fetching.
 * Bypasses RLS — use only in server components / API routes, never in client code.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
