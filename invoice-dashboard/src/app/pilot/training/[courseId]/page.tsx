import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect, notFound } from "next/navigation";
import CourseDetail from "./CourseDetail";

export const dynamic = "force-dynamic";

export default async function CourseDetailPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const id = Number(courseId);
  if (!id || isNaN(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const role = user.app_metadata?.role ?? user.user_metadata?.role;
  if (role !== "pilot" && role !== "admin") redirect("/");

  const supa = createServiceClient();
  const isAdmin = role === "admin";

  const { data: course } = await supa
    .from("lms_courses")
    .select("*")
    .eq("id", id)
    .single();

  if (!course) notFound();

  // Non-admins can only see published courses they're assigned to
  if (!isAdmin) {
    if (course.status !== "published") notFound();
    const { data: assignment } = await supa
      .from("lms_assignments")
      .select("id")
      .eq("course_id", id)
      .eq("user_id", user.id)
      .single();
    if (!assignment) notFound();
  }

  const { data: modules } = await supa
    .from("lms_modules")
    .select("*")
    .eq("course_id", id)
    .order("sort_order", { ascending: true });

  const moduleIds = (modules ?? []).map((m: { id: number }) => m.id);
  let lessons: Record<string, unknown>[] = [];

  if (moduleIds.length > 0) {
    const { data } = await supa
      .from("lms_lessons")
      .select("*")
      .in("module_id", moduleIds)
      .order("sort_order", { ascending: true });
    lessons = data ?? [];
  }

  // Fetch progress for pilot
  let completedLessonIds: number[] = [];
  if (!isAdmin) {
    const lessonIds = lessons.map((l) => (l as { id: number }).id);
    if (lessonIds.length > 0) {
      const { data: progress } = await supa
        .from("lms_progress")
        .select("lesson_id")
        .eq("user_id", user.id)
        .in("lesson_id", lessonIds);
      completedLessonIds = (progress ?? []).map(
        (p: { lesson_id: number }) => p.lesson_id
      );
    }
  }

  // Fetch quiz attempt stats for admins
  let quizStats: { lesson_id: number; total_attempts: number; unique_users: number; avg_score_pct: number }[] = [];
  if (isAdmin) {
    const quizLessonIds = lessons
      .filter((l) => (l as { lesson_type: string }).lesson_type === "quiz")
      .map((l) => (l as { id: number }).id);

    if (quizLessonIds.length > 0) {
      // Get all questions for these quiz lessons
      const { data: questions } = await supa
        .from("lms_quiz_questions")
        .select("id, lesson_id")
        .in("lesson_id", quizLessonIds);

      const questionIds = (questions ?? []).map((q: { id: number }) => q.id);
      const questionLessonMap: Record<number, number> = {};
      for (const q of questions ?? []) {
        const qq = q as { id: number; lesson_id: number };
        questionLessonMap[qq.id] = qq.lesson_id;
      }

      // Count questions per lesson for score calculation
      const questionsPerLesson: Record<number, number> = {};
      for (const q of questions ?? []) {
        const qq = q as { id: number; lesson_id: number };
        questionsPerLesson[qq.lesson_id] = (questionsPerLesson[qq.lesson_id] || 0) + 1;
      }

      if (questionIds.length > 0) {
        const { data: attempts } = await supa
          .from("lms_quiz_attempts")
          .select("user_id, question_id, is_correct")
          .in("question_id", questionIds);

        // Aggregate by lesson
        const lessonAttempts: Record<number, { users: Set<string>; correct: number; total: number }> = {};
        for (const a of attempts ?? []) {
          const att = a as { user_id: string; question_id: number; is_correct: boolean };
          const lessonId = questionLessonMap[att.question_id];
          if (!lessonId) continue;
          if (!lessonAttempts[lessonId]) {
            lessonAttempts[lessonId] = { users: new Set(), correct: 0, total: 0 };
          }
          lessonAttempts[lessonId].users.add(att.user_id);
          lessonAttempts[lessonId].total++;
          if (att.is_correct) lessonAttempts[lessonId].correct++;
        }

        quizStats = Object.entries(lessonAttempts).map(([lid, stats]) => ({
          lesson_id: Number(lid),
          total_attempts: stats.total,
          unique_users: stats.users.size,
          avg_score_pct: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
        }));
      }
    }
  }

  return (
    <CourseDetail
      course={course}
      modules={modules ?? []}
      lessons={lessons}
      completedLessonIds={completedLessonIds}
      isAdmin={isAdmin}
      quizStats={quizStats}
    />
  );
}
