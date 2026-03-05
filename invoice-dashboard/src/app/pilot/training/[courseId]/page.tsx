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

  return (
    <CourseDetail
      course={course}
      modules={modules ?? []}
      lessons={lessons}
      completedLessonIds={completedLessonIds}
      isAdmin={isAdmin}
    />
  );
}
