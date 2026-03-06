import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/training/assignments — list assignments
 * Pilots: own assignments only. Admins: all.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  if (auth.role === "admin") {
    const { data, error } = await supa
      .from("lms_assignments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
    }
    return NextResponse.json({ assignments: data });
  }

  const { data, error } = await supa
    .from("lms_assignments")
    .select("*")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ assignments: data });
}

/**
 * POST /api/pilot/training/assignments — assign course to pilot (admin only)
 * Body: { course_id, user_id, due_date? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { course_id?: number; user_id?: string; due_date?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.course_id || !body.user_id) {
    return NextResponse.json({ error: "course_id and user_id are required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_assignments")
    .upsert(
      {
        course_id: body.course_id,
        user_id: body.user_id,
        assigned_by: auth.userId,
        due_date: body.due_date || null,
      },
      { onConflict: "course_id,user_id" },
    )
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ assignment: data }, { status: 201 });
}
