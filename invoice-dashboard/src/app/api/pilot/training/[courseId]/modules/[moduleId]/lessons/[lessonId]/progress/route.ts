import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteParams = { courseId: string; moduleId: string; lessonId: string };

/**
 * POST /api/pilot/training/[courseId]/modules/[moduleId]/lessons/[lessonId]/progress
 * Upsert lesson completion (idempotent "Mark Complete").
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Upsert: insert or do nothing if already completed
  const { error } = await supa
    .from("lms_progress")
    .upsert(
      { user_id: auth.userId, lesson_id: id, completed_at: new Date().toISOString() },
      { onConflict: "user_id,lesson_id" },
    );

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
