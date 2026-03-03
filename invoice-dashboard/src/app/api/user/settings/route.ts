import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const DEFAULT_TABS = ["ops", "invoices", "alerts", "jobs", "maintenance", "vehicles", "fuel-prices", "fees"];

/**
 * GET /api/user/settings — returns the current user's settings (allowed tabs, role).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  const { data: row } = await supa
    .from("user_settings")
    .select("allowed_tabs")
    .eq("user_id", auth.userId)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    email: auth.email,
    role: auth.role ?? "user",
    allowed_tabs: row?.allowed_tabs ?? DEFAULT_TABS,
  });
}
