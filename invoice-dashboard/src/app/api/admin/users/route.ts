import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const DEFAULT_TABS = ["ops", "invoices", "alerts", "jobs", "maintenance", "vehicles", "fuel-prices", "fees"];

/**
 * GET /api/admin/users — list all users with their settings (tab access).
 * POST /api/admin/users — update a user's settings (allowed_tabs, role).
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const adminClient = createClient(supabaseUrl, serviceKey);
  const supa = createServiceClient();

  // Get all auth users
  const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers({ perPage: 200 });
  if (authErr) {
    return NextResponse.json({ error: "Failed to list users" }, { status: 500 });
  }

  // Get all user_settings rows
  const { data: settingsRows } = await supa
    .from("user_settings")
    .select("*")
    .order("email", { ascending: true });

  const settingsMap = new Map<string, { allowed_tabs: string[] }>();
  for (const row of settingsRows ?? []) {
    settingsMap.set(row.user_id, {
      allowed_tabs: Array.isArray(row.allowed_tabs) ? row.allowed_tabs : DEFAULT_TABS,
    });
  }

  const users = (authData?.users ?? []).map((u) => ({
    id: u.id,
    email: u.email ?? "",
    role: (u.app_metadata?.role as string) ?? "user",
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
    allowed_tabs: settingsMap.get(u.id)?.allowed_tabs ?? DEFAULT_TABS,
  }));

  return NextResponse.json({ ok: true, users, available_tabs: DEFAULT_TABS });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userId = String(body.user_id ?? "").trim();
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const adminClient = createClient(supabaseUrl, serviceKey);
  const supa = createServiceClient();

  // Update role if provided
  if (typeof body.role === "string") {
    const newRole = body.role === "admin" ? "admin" : "user";
    const { error: roleErr } = await adminClient.auth.admin.updateUserById(userId, {
      app_metadata: { role: newRole },
    });
    if (roleErr) {
      return NextResponse.json({ error: `Failed to update role: ${roleErr.message}` }, { status: 500 });
    }
  }

  // Update allowed_tabs if provided
  if (Array.isArray(body.allowed_tabs)) {
    const allowedTabs = body.allowed_tabs.filter(
      (t: unknown) => typeof t === "string" && DEFAULT_TABS.includes(t as string),
    );

    // Look up user email for the settings row
    const { data: userData } = await adminClient.auth.admin.getUserById(userId);
    const email = userData?.user?.email ?? "";

    const { error: tabsErr } = await supa
      .from("user_settings")
      .upsert(
        {
          user_id: userId,
          email,
          allowed_tabs: allowedTabs,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    if (tabsErr) {
      console.error("[admin/users] upsert error:", tabsErr);
      return NextResponse.json({ error: "Failed to save tab settings" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
