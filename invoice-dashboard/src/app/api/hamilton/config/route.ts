import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

const HAMILTON_BASE = "https://app.hamilton.ai";

/** Quick probe — hit Hamilton API to see if the cookie actually works */
async function testHamiltonCookie(cookie: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${HAMILTON_BASE}/api/operator-trips?pageSize=1&sortColumn=updatedAt&sortOrder=desc&stage=CANCELLED`,
      {
        headers: {
          Cookie: `wos-session=${cookie}`,
          Accept: "*/*",
          "User-Agent": "Baker-Aviation-Sync/1.0",
          Referer: `${HAMILTON_BASE}/sales/leads`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    // Hamilton returns 302 when session is dead
    return res.status !== 302 && res.ok;
  } catch {
    // Network error — don't block the save, just can't confirm
    return true;
  }
}

/**
 * GET /api/hamilton/config — Read Hamilton config (cookie status)
 * PUT /api/hamilton/config — Update session cookie or agent name mappings
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();
  const { data } = await supa
    .from("hamilton_config")
    .select("config_key, config_value, updated_at");

  const config: Record<string, { value: string; updated_at: string }> = {};
  for (const row of data ?? []) {
    config[row.config_key] = {
      value:
        row.config_key === "session_cookie"
          ? row.config_value
            ? `...${row.config_value.slice(-20)}`
            : ""
          : row.config_value,
      updated_at: row.updated_at,
    };
  }

  // Actually validate the cookie against Hamilton
  const cookieRow = data?.find((r) => r.config_key === "session_cookie");
  let cookieStatus: string;
  if (!cookieRow?.config_value) {
    cookieStatus = "missing";
  } else {
    const valid = await testHamiltonCookie(cookieRow.config_value);
    cookieStatus = valid ? "ok" : "expired";
  }

  return NextResponse.json({ config, cookieStatus });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: { key?: string; value?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key?.trim();
  const value = body.value?.trim();

  if (!key || !value) {
    return NextResponse.json(
      { error: "key and value are required" },
      { status: 400 },
    );
  }

  if (!["session_cookie", "agent_names"].includes(key)) {
    return NextResponse.json(
      { error: `Unknown config key: ${key}` },
      { status: 400 },
    );
  }

  // Validate the cookie actually works before saving
  if (key === "session_cookie") {
    const valid = await testHamiltonCookie(value);
    if (!valid) {
      return NextResponse.json(
        { error: "Cookie rejected by Hamilton — session is expired or invalid. Log in again and copy a fresh cookie." },
        { status: 422 },
      );
    }
  }

  const supa = createServiceClient();
  const { error } = await supa.from("hamilton_config").upsert(
    {
      config_key: key,
      config_value: value,
      updated_by: auth.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "config_key" },
  );

  if (error) {
    return NextResponse.json(
      { error: "Failed to save config" },
      { status: 500 },
    );
  }

  // Clear expiry alert throttle so the cron doesn't immediately re-alert
  if (key === "session_cookie") {
    await supa
      .from("hamilton_config")
      .delete()
      .eq("config_key", "expiry_alerted_at");
  }

  return NextResponse.json({ ok: true });
}
