import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteParams = {
  courseId: string;
  moduleId: string;
  lessonId: string;
  questionId: string;
};

/**
 * PATCH /api/pilot/training/.../quiz/[questionId] — update quiz question (admin only)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { questionId } = await params;
  const id = Number(questionId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid question ID" }, { status: 400 });
  }

  let body: {
    question?: string;
    options?: string[];
    correct_answer?: number;
    sort_order?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (body.question !== undefined) {
    const question = body.question.trim();
    if (!question) return NextResponse.json({ error: "Question cannot be empty" }, { status: 400 });
    updates.question = question;
  }

  if (body.options !== undefined) {
    if (!Array.isArray(body.options) || body.options.length < 2) {
      return NextResponse.json({ error: "At least 2 options required" }, { status: 400 });
    }
    updates.options = body.options;
  }

  if (body.correct_answer !== undefined) {
    const optLen = body.options?.length ?? 4;
    if (body.correct_answer < 0 || body.correct_answer >= optLen) {
      return NextResponse.json({ error: "Invalid correct_answer index" }, { status: 400 });
    }
    updates.correct_answer = body.correct_answer;
  }

  if (body.sort_order !== undefined) updates.sort_order = body.sort_order;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_quiz_questions")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ question: data });
}

/**
 * DELETE /api/pilot/training/.../quiz/[questionId] — delete quiz question (admin only)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { questionId } = await params;
  const id = Number(questionId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid question ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from("lms_quiz_questions").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
