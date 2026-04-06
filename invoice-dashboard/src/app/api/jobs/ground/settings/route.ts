import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const ALLOWED_KEYS = [
  "ground_phone_screen_calendly_url",
  "ground_interview_calendly_url",
  "ground_phone_screen_email_template",
  "ground_interview_email_template",
  "ground_rejection_email_soft",
  "ground_rejection_email_hard",
  "ground_rejection_email_left",
];

/** GET — fetch ground hiring settings */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("hiring_settings")
    .select("key, value, updated_at")
    .in("key", ALLOWED_KEYS);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }

  const settings: Record<string, string> = {};
  for (const row of data ?? []) {
    settings[row.key] = row.value;
  }

  return NextResponse.json({ ok: true, settings });
}

/** PATCH — upsert a ground hiring setting */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { key?: string; value?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { key, value } = body;
  if (!key || typeof key !== "string") {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }
  // Allow empty string for value (clearing a setting)
  if (value === undefined || value === null) {
    return NextResponse.json({ error: "value is required (can be empty string)" }, { status: 400 });
  }

  if (!ALLOWED_KEYS.includes(key)) {
    return NextResponse.json({ error: `Unknown setting key: ${key}` }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("hiring_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

  if (error) {
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
