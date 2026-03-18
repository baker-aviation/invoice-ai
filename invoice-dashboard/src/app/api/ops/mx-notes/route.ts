import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/ops/mx-notes — list active MX notes with attachment counts
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("ops_alerts")
    .select("id, tail_number, airport_icao, subject, body, created_at, acknowledged_at, raw_data")
    .eq("alert_type", "MX_NOTE")
    .is("acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[ops/mx-notes] list error:", error);
    return NextResponse.json({ error: "Failed to list MX notes" }, { status: 500 });
  }

  // Get attachment counts for all notes in one query
  const noteIds = (data ?? []).map((r) => r.id);
  let attachmentCounts: Record<string, number> = {};
  if (noteIds.length > 0) {
    const { data: counts } = await supa
      .from("mx_note_attachments")
      .select("alert_id")
      .in("alert_id", noteIds);
    if (counts) {
      for (const row of counts) {
        attachmentCounts[row.alert_id] = (attachmentCounts[row.alert_id] || 0) + 1;
      }
    }
  }

  const notes = (data ?? []).map((row) => {
    let startTime: string | null = null;
    let endTime: string | null = null;
    let description: string | null = null;
    try {
      const rd = typeof row.raw_data === "string" ? JSON.parse(row.raw_data) : row.raw_data;
      startTime = rd?.start_time ?? null;
      endTime = rd?.end_time ?? null;
      description = rd?.description ?? null;
    } catch { /* ignore */ }
    return {
      id: row.id,
      tail_number: row.tail_number,
      airport_icao: row.airport_icao,
      subject: row.subject,
      body: row.body,
      description,
      start_time: startTime,
      end_time: endTime,
      created_at: row.created_at,
      acknowledged_at: row.acknowledged_at,
      attachment_count: attachmentCounts[row.id as string] ?? 0,
    };
  });

  return NextResponse.json({ notes });
}

/**
 * POST /api/ops/mx-notes — create a new MX note
 * JSON body: { subject, body?, tail_number?, airport_icao? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: { subject?: string; body?: string; tail_number?: string; airport_icao?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subject = input.subject?.trim();
  if (!subject) {
    return NextResponse.json({ error: "subject is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: note, error } = await supa
    .from("ops_alerts")
    .insert({
      alert_type: "MX_NOTE",
      severity: "info",
      subject,
      body: input.body?.trim() || null,
      tail_number: input.tail_number?.trim() || null,
      airport_icao: input.airport_icao?.trim().toUpperCase() || null,
    })
    .select("id, tail_number, airport_icao, subject, body, created_at")
    .single();

  if (error) {
    console.error("[ops/mx-notes] insert error:", error);
    return NextResponse.json({ error: "Failed to create MX note" }, { status: 500 });
  }

  return NextResponse.json({ note }, { status: 201 });
}
