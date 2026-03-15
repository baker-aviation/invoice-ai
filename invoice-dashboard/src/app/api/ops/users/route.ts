import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/ops/users — lightweight user ID → display name map.
 * Any authenticated user can call this (not admin-only).
 * Returns only id and email prefix — no sensitive data.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) {
    return NextResponse.json({ error: "Failed to list users" }, { status: 500 });
  }

  const users: Record<string, string> = {};
  for (const u of data.users) {
    if (u.email) {
      users[u.id] = u.email.split("@")[0];
    }
  }

  return NextResponse.json({ users });
}
