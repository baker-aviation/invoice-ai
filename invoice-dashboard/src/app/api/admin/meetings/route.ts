import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { presignUpload } from "@/lib/gcs-upload";

/**
 * GET /api/admin/meetings
 * List all meetings, or get presigned upload URLs.
 *
 * ?action=presign&filename=video.mov  → presigned upload URL
 * ?action=presign-screenshots&meeting_id=123&count=5  → batch screenshot presign
 * (default) → list meetings
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  // Presign a single upload (video or audio chunk)
  if (action === "presign") {
    const filename = searchParams.get("filename") || "video.mov";
    const meetingId = searchParams.get("meeting_id") || "unknown";
    const result = await presignUpload(filename, `meetings/${meetingId}`);
    return NextResponse.json(result);
  }

  // Get single meeting by ID (with full fields including transcript)
  if (action === "get") {
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const sb = createServiceClient();
    const { data, error } = await sb.from("meetings").select("*").eq("id", id).single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ meeting: data });
  }

  // Batch presign for screenshots
  if (action === "presign-screenshots") {
    const meetingId = searchParams.get("meeting_id");
    const count = parseInt(searchParams.get("count") || "0", 10);
    if (!meetingId || count <= 0) {
      return NextResponse.json({ error: "meeting_id and count required" }, { status: 400 });
    }

    const results = [];
    for (let i = 0; i < count; i++) {
      const result = await presignUpload(
        `frame_${String(i).padStart(4, "0")}.jpg`,
        `meetings/${meetingId}/screenshots`,
      );
      results.push(result);
    }
    return NextResponse.json({ uploads: results });
  }

  // Default: list meetings
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("meetings")
    .select("id, title, status, duration_sec, screenshot_count, error_message, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also get ticket counts per meeting
  const meetingIds = (data || []).map((m) => m.id);
  let ticketCounts: Record<number, number> = {};

  if (meetingIds.length > 0) {
    const { data: tickets } = await sb
      .from("meeting_tickets")
      .select("meeting_id")
      .in("meeting_id", meetingIds);

    if (tickets) {
      ticketCounts = tickets.reduce(
        (acc, t) => {
          acc[t.meeting_id] = (acc[t.meeting_id] || 0) + 1;
          return acc;
        },
        {} as Record<number, number>,
      );
    }
  }

  const meetings = (data || []).map((m) => ({
    ...m,
    ticket_count: ticketCounts[m.id] || 0,
  }));

  return NextResponse.json({ meetings });
}

/**
 * POST /api/admin/meetings
 * Create a new meeting record.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { title, video_gcs_key, duration_sec } = body;

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("meetings")
    .insert({
      title: title || "Untitled Meeting",
      video_gcs_key: video_gcs_key || null,
      duration_sec: duration_sec || null,
      status: "processing",
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, meeting: data });
}

/**
 * PATCH /api/admin/meetings
 * Update a meeting. Body: { id, ...fields }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const allowed: Record<string, unknown> = {};
  for (const key of ["title", "status", "transcript", "summary", "video_gcs_key", "error_message", "duration_sec", "screenshot_count"]) {
    if (key in updates) allowed[key] = updates[key];
  }
  allowed.updated_at = new Date().toISOString();

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("meetings")
    .update(allowed)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, meeting: data });
}

/**
 * DELETE /api/admin/meetings?id=123
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb.from("meetings").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
