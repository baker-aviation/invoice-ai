import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { redirect, notFound } from "next/navigation";
import LessonViewer from "./LessonViewer";

export const dynamic = "force-dynamic";

export default async function LessonPage({
  params,
}: {
  params: Promise<{ courseId: string; lessonId: string }>;
}) {
  const { courseId, lessonId } = await params;
  const cId = Number(courseId);
  const lId = Number(lessonId);
  if (!cId || isNaN(cId) || !lId || isNaN(lId)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const role = user.app_metadata?.role ?? user.user_metadata?.role;
  if (role !== "pilot" && role !== "admin") redirect("/");

  const supa = createServiceClient();
  const isAdmin = role === "admin";

  // Verify course exists and user has access
  const { data: course } = await supa
    .from("lms_courses")
    .select("id, title, status")
    .eq("id", cId)
    .single();

  if (!course) notFound();
  if (!isAdmin && course.status !== "published") notFound();

  if (!isAdmin) {
    const { data: assignment } = await supa
      .from("lms_assignments")
      .select("id")
      .eq("course_id", cId)
      .eq("user_id", user.id)
      .single();
    if (!assignment) notFound();
  }

  // Fetch lesson
  const { data: lesson } = await supa
    .from("lms_lessons")
    .select("*")
    .eq("id", lId)
    .single();

  if (!lesson) notFound();

  // Sign GCS URLs for video/document
  let videoUrl: string | null = null;
  let docUrl: string | null = null;

  if (lesson.video_gcs_bucket && lesson.video_gcs_key) {
    videoUrl = await signGcsUrl(lesson.video_gcs_bucket, lesson.video_gcs_key);
  }
  if (lesson.doc_gcs_bucket && lesson.doc_gcs_key) {
    docUrl = await signGcsUrl(lesson.doc_gcs_bucket, lesson.doc_gcs_key);
  }

  // For quiz: fetch questions, strip correct_answer for non-admins
  let quizQuestions: Record<string, unknown>[] = [];
  if (lesson.lesson_type === "quiz") {
    const { data: questions } = await supa
      .from("lms_quiz_questions")
      .select("*")
      .eq("lesson_id", lId)
      .order("sort_order", { ascending: true });

    quizQuestions = (questions ?? []).map((q: Record<string, unknown>) => {
      if (!isAdmin) {
        const { correct_answer: _, ...rest } = q;
        return rest;
      }
      return q;
    });
  }

  // Check if lesson is already completed
  let isCompleted = false;
  if (!isAdmin) {
    const { data: progress } = await supa
      .from("lms_progress")
      .select("id")
      .eq("user_id", user.id)
      .eq("lesson_id", lId)
      .single();
    isCompleted = !!progress;
  }

  // Get all lessons in this course for prev/next navigation
  const { data: modules } = await supa
    .from("lms_modules")
    .select("id, sort_order")
    .eq("course_id", cId)
    .order("sort_order", { ascending: true });

  const moduleIds = (modules ?? []).map((m: { id: number }) => m.id);
  let allLessons: { id: number; module_id: number; sort_order: number }[] = [];

  if (moduleIds.length > 0) {
    const { data } = await supa
      .from("lms_lessons")
      .select("id, module_id, sort_order")
      .in("module_id", moduleIds)
      .order("sort_order", { ascending: true });
    allLessons = (data ?? []) as { id: number; module_id: number; sort_order: number }[];
  }

  // Sort lessons by module sort_order then lesson sort_order
  const moduleOrderMap: Record<number, number> = {};
  for (const m of modules ?? []) {
    const mod = m as { id: number; sort_order: number };
    moduleOrderMap[mod.id] = mod.sort_order;
  }
  allLessons.sort((a, b) => {
    const ma = moduleOrderMap[a.module_id] ?? 0;
    const mb = moduleOrderMap[b.module_id] ?? 0;
    if (ma !== mb) return ma - mb;
    return a.sort_order - b.sort_order;
  });

  const currentIndex = allLessons.findIndex((l) => l.id === lId);
  const prevLessonId = currentIndex > 0 ? allLessons[currentIndex - 1].id : null;
  const nextLessonId =
    currentIndex >= 0 && currentIndex < allLessons.length - 1
      ? allLessons[currentIndex + 1].id
      : null;

  return (
    <LessonViewer
      courseId={cId}
      courseTitle={course.title}
      lesson={lesson}
      videoUrl={videoUrl}
      docUrl={docUrl}
      quizQuestions={quizQuestions}
      isCompleted={isCompleted}
      isAdmin={isAdmin}
      prevLessonId={prevLessonId}
      nextLessonId={nextLessonId}
    />
  );
}
