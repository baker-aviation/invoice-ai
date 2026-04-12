import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";
import { isLoginRedirect } from "@/lib/jetinsight/parser";

const JI_BASE = "https://portal.jetinsight.com";

/** Quick probe — hit a lightweight JI endpoint to see if the cookie actually works */
async function testJetInsightCookie(cookie: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${JI_BASE}/schedule/aircraft.json?start=2026-01-01&end=2026-01-02`,
      {
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "User-Agent": "Baker-Aviation-Sync/1.0",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return false;
    const text = await res.text();
    return !isLoginRedirect(text);
  } catch {
    // Network error — don't block the save, just can't confirm
    return true;
  }
}

/**
 * GET /api/jetinsight/config — Read JetInsight config (cookie status, org UUID)
 * PUT /api/jetinsight/config — Update session cookie or org UUID
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();
  const { data } = await supa
    .from("jetinsight_config")
    .select("config_key, config_value, updated_at");

  // Build config object, masking the session cookie
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

  // Actually validate the cookie against JetInsight
  const cookieRow = data?.find((r) => r.config_key === "session_cookie");
  let cookieStatus: string;
  if (!cookieRow?.config_value) {
    cookieStatus = "missing";
  } else {
    const valid = await testJetInsightCookie(cookieRow.config_value);
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

  // Only allow known config keys
  if (!["session_cookie", "org_uuid"].includes(key)) {
    return NextResponse.json(
      { error: `Unknown config key: ${key}` },
      { status: 400 },
    );
  }

  // Validate the cookie actually works before saving
  if (key === "session_cookie") {
    const valid = await testJetInsightCookie(value);
    if (!valid) {
      return NextResponse.json(
        { error: "Cookie rejected by JetInsight — session is expired or invalid. Log in again and copy a fresh cookie." },
        { status: 422 },
      );
    }
  }

  const supa = createServiceClient();
  const { error } = await supa.from("jetinsight_config").upsert(
    {
      config_key: key,
      config_value: value,
      updated_by: auth.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "config_key" },
  );

  if (error) {
    console.error("[jetinsight/config] upsert error:", error);
    return NextResponse.json(
      { error: "Failed to save config" },
      { status: 500 },
    );
  }

  // Clear expiry alert throttle so the cron doesn't immediately re-alert
  if (key === "session_cookie") {
    await supa
      .from("jetinsight_config")
      .delete()
      .eq("config_key", "expiry_alerted_at");
  }

  return NextResponse.json({ ok: true });
}
