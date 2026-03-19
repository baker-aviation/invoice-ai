import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/training — list courses
 * Pilots: only published + assigned. Admins: all.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  if (auth.role === "admin") {
    const { data, error } = await supa
      .from("lms_courses")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
    }
    return NextResponse.json({ courses: data });
  }

  // Pilot: get assigned courses
  const { data: assignments } = await supa
    .from("lms_assignments")
    .select("course_id")
    .eq("user_id", auth.userId);

  const courseIds = (assignments ?? []).map((a: { course_id: number }) => a.course_id);
  if (courseIds.length === 0) {
    return NextResponse.json({ courses: [] });
  }

  const { data, error } = await supa
    .from("lms_courses")
    .select("*")
    .in("id", courseIds)
    .eq("status", "published")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ courses: data });
}

/**
 * POST /api/pilot/training — create course (admin only)
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { title?: string; description?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_courses")
    .insert({
      title,
      description: body.description?.trim() || null,
      category: body.category?.trim() || null,
      created_by: auth.userId,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ course: data }, { status: 201 });
}
