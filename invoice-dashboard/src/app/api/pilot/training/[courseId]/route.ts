import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/training/[courseId] — single course
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { courseId } = await params;
  const id = Number(courseId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid course ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_courses")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // Pilots can only see published courses
  if (auth.role !== "admin" && data.status !== "published") {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  return NextResponse.json({ course: data });
}

/**
 * PATCH /api/pilot/training/[courseId] — update course (admin only)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { courseId } = await params;
  const id = Number(courseId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid course ID" }, { status: 400 });
  }

  let body: { title?: string; description?: string; category?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
    updates.title = title;
  }
  if (body.description !== undefined) updates.description = body.description.trim() || null;
  if (body.category !== undefined) updates.category = body.category.trim() || null;
  if (body.status !== undefined) {
    if (body.status !== "draft" && body.status !== "published") {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.status = body.status;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_courses")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ course: data });
}

/**
 * DELETE /api/pilot/training/[courseId] — delete course (admin only)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { courseId } = await params;
  const id = Number(courseId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid course ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from("lms_courses").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
