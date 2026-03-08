import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteParams = { courseId: string; moduleId: string; lessonId: string };

/**
 * GET /api/pilot/training/.../quiz — list quiz questions
 * Strips correct_answer for non-admin users.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_quiz_questions")
    .select("*")
    .eq("lesson_id", id)
    .order("sort_order", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  const questions = (data ?? []).map((q: Record<string, unknown>) => {
    if (auth.role !== "admin") {
      const { correct_answer: _, ...rest } = q;
      return rest;
    }
    return q;
  });

  return NextResponse.json({ questions });
}

/**
 * POST /api/pilot/training/.../quiz — create quiz question (admin only)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
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

  const question = body.question?.trim();
  if (!question) {
    return NextResponse.json({ error: "Question is required" }, { status: 400 });
  }

  if (!Array.isArray(body.options) || body.options.length < 2) {
    return NextResponse.json({ error: "At least 2 options required" }, { status: 400 });
  }

  if (body.correct_answer === undefined || body.correct_answer < 0 || body.correct_answer >= body.options.length) {
    return NextResponse.json({ error: "Invalid correct_answer index" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_quiz_questions")
    .insert({
      lesson_id: id,
      question,
      options: body.options,
      correct_answer: body.correct_answer,
      sort_order: body.sort_order ?? 0,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ question: data }, { status: 201 });
}

/**
 * PUT /api/pilot/training/.../quiz — submit quiz answers & grade
 * Body: { answers: { [question_id]: selected_answer_index } }
 * Pass threshold: 80%
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
  }

  let body: { answers?: Record<string, number> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.answers || typeof body.answers !== "object") {
    return NextResponse.json({ error: "answers object is required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch all questions with correct answers for grading
  const { data: questions, error: qErr } = await supa
    .from("lms_quiz_questions")
    .select("id, correct_answer")
    .eq("lesson_id", id);

  if (qErr || !questions || questions.length === 0) {
    return NextResponse.json({ error: "No quiz questions found" }, { status: 404 });
  }

  // Grade each answer
  const results: { question_id: number; is_correct: boolean }[] = [];
  const attempts: {
    user_id: string;
    question_id: number;
    selected_answer: number;
    is_correct: boolean;
    attempted_at: string;
  }[] = [];

  const now = new Date().toISOString();

  for (const q of questions) {
    const selected = body.answers[String(q.id)];
    if (selected === undefined) continue;

    const isCorrect = selected === q.correct_answer;
    results.push({ question_id: q.id, is_correct: isCorrect });
    attempts.push({
      user_id: auth.userId,
      question_id: q.id,
      selected_answer: selected,
      is_correct: isCorrect,
      attempted_at: now,
    });
  }

  // Save attempts
  if (attempts.length > 0) {
    await supa.from("lms_quiz_attempts").insert(attempts);
  }

  const score = results.filter((r) => r.is_correct).length;
  const total = questions.length;
  const passed = total > 0 && score / total >= 0.8;

  // If passed, auto-complete the lesson
  if (passed) {
    await supa
      .from("lms_progress")
      .upsert(
        { user_id: auth.userId, lesson_id: id, completed_at: now },
        { onConflict: "user_id,lesson_id" },
      );
  }

  return NextResponse.json({ score, total, passed, results });
}
