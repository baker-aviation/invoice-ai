import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

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

  const cookieRow = data?.find((r) => r.config_key === "session_cookie");
  const cookieAge = cookieRow
    ? Date.now() - new Date(cookieRow.updated_at).getTime()
    : Infinity;
  const cookieStatus = !cookieRow?.config_value
    ? "missing"
    : cookieAge > 24 * 60 * 60 * 1000
      ? "stale"
      : "ok";

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

  return NextResponse.json({ ok: true });
}
