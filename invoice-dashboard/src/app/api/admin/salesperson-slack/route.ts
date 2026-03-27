import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * CRUD for salesperson_slack_map table.
 * Maps salesperson names to Slack user IDs for DM notifications.
 */

/** GET — list all mappings */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("salesperson_slack_map")
    .select("*")
    .order("salesperson_name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ mappings: data ?? [] });
}

/** POST — upsert a mapping */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { salesperson_name?: string; slack_user_id?: string; quotes_enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.salesperson_name?.trim();
  const slackId = body.slack_user_id?.trim();

  if (!name || !slackId) {
    return NextResponse.json({ error: "salesperson_name and slack_user_id are required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const row: Record<string, unknown> = { salesperson_name: name, slack_user_id: slackId };
  if (typeof body.quotes_enabled === "boolean") {
    row.quotes_enabled = body.quotes_enabled;
  }
  const { error } = await supa
    .from("salesperson_slack_map")
    .upsert(row, { onConflict: "salesperson_name" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/** PATCH — toggle quotes_enabled for a salesperson */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { salesperson_name?: string; quotes_enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.salesperson_name?.trim();
  if (!name || typeof body.quotes_enabled !== "boolean") {
    return NextResponse.json({ error: "salesperson_name and quotes_enabled (boolean) are required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("salesperson_slack_map")
    .update({ quotes_enabled: body.quotes_enabled })
    .eq("salesperson_name", name);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/** DELETE — remove a mapping by name */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: { salesperson_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.salesperson_name?.trim();
  if (!name) {
    return NextResponse.json({ error: "salesperson_name is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("salesperson_slack_map")
    .delete()
    .eq("salesperson_name", name);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
