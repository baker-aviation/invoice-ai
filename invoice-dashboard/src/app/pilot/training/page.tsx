import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect } from "next/navigation";
import TrainingHome from "./TrainingHome";

export const dynamic = "force-dynamic";

export default async function TrainingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const role = user.app_metadata?.role ?? user.user_metadata?.role;
  if (role !== "pilot" && role !== "admin") redirect("/");

  const supa = createServiceClient();
  const isAdmin = role === "admin";

  // Admins see all courses; pilots see only assigned published courses
  let courses: Record<string, unknown>[] = [];

  if (isAdmin) {
    const { data } = await supa
      .from("lms_courses")
      .select("*")
      .order("created_at", { ascending: false });
    courses = data ?? [];
  } else {
    // Get assigned course IDs
    const { data: assignments } = await supa
      .from("lms_assignments")
      .select("course_id")
      .eq("user_id", user.id);

    const courseIds = (assignments ?? []).map((a: { course_id: number }) => a.course_id);

    if (courseIds.length > 0) {
      const { data } = await supa
        .from("lms_courses")
        .select("*")
        .in("id", courseIds)
        .eq("status", "published")
        .order("created_at", { ascending: false });
      courses = data ?? [];
    }
  }

  // Get lesson counts per course and progress counts for pilot
  const courseIds = courses.map((c) => (c as { id: number }).id);
  let lessonCounts: Record<number, number> = {};
  let progressCounts: Record<number, number> = {};

  if (courseIds.length > 0) {
    // Get all modules for these courses
    const { data: modules } = await supa
      .from("lms_modules")
      .select("id, course_id")
      .in("course_id", courseIds);

    const moduleIds = (modules ?? []).map((m: { id: number }) => m.id);
    const moduleCourseMap: Record<number, number> = {};
    for (const m of modules ?? []) {
      const mod = m as { id: number; course_id: number };
      moduleCourseMap[mod.id] = mod.course_id;
    }

    if (moduleIds.length > 0) {
      const { data: lessons } = await supa
        .from("lms_lessons")
        .select("id, module_id")
        .in("module_id", moduleIds);

      // Count lessons per course
      for (const l of lessons ?? []) {
        const lesson = l as { id: number; module_id: number };
        const courseId = moduleCourseMap[lesson.module_id];
        if (courseId) {
          lessonCounts[courseId] = (lessonCounts[courseId] || 0) + 1;
        }
      }

      if (!isAdmin) {
        const lessonIds = (lessons ?? []).map((l: { id: number }) => l.id);
        if (lessonIds.length > 0) {
          const { data: progress } = await supa
            .from("lms_progress")
            .select("lesson_id")
            .eq("user_id", user.id)
            .in("lesson_id", lessonIds);

          for (const p of progress ?? []) {
            const prog = p as { lesson_id: number };
            // Find which course this lesson belongs to
            const lesson = (lessons ?? []).find(
              (l) => (l as { id: number }).id === prog.lesson_id
            ) as { id: number; module_id: number } | undefined;
            if (lesson) {
              const courseId = moduleCourseMap[lesson.module_id];
              if (courseId) {
                progressCounts[courseId] = (progressCounts[courseId] || 0) + 1;
              }
            }
          }
        }
      }
    }
  }

  return (
    <TrainingHome
      courses={courses}
      lessonCounts={lessonCounts}
      progressCounts={progressCounts}
      isAdmin={isAdmin}
    />
  );
}
