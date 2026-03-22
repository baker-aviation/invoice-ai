import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET — list active custom alerts (optionally filtered by airport) */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const airport = req.nextUrl.searchParams.get("airport");

  const supa = createServiceClient();
  let query = supa
    .from("custom_notam_alerts")
    .select("*")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (airport) {
    query = query.or(`airport_icao.eq.${airport},airport_icao.is.null`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter out expired on the app side (Supabase doesn't support now() in filters easily)
  const now = new Date().toISOString();
  const active = (data ?? []).filter((a) => !a.expires_at || a.expires_at > now);

  return NextResponse.json({ alerts: active });
}

/** POST — create a custom alert */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subject = (input.subject as string)?.trim();
  if (!subject || subject.length > 200) {
    return NextResponse.json({ error: "subject required (max 200 chars)" }, { status: 400 });
  }

  const severity = (input.severity as string) ?? "info";
  if (!["critical", "warning", "info"].includes(severity)) {
    return NextResponse.json({ error: "severity must be critical, warning, or info" }, { status: 400 });
  }

  const body = (input.body as string)?.trim() || null;
  if (body && body.length > 2000) {
    return NextResponse.json({ error: "body max 2000 chars" }, { status: 400 });
  }

  const airport_icao = (input.airport_icao as string)?.toUpperCase().trim() || null;
  const expires_at = (input.expires_at as string) || null;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("custom_notam_alerts")
    .insert({
      airport_icao,
      severity,
      subject,
      body,
      created_by: auth.userId,
      created_by_name: auth.email ?? null,
      expires_at,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ alert: data }, { status: 201 });
}
