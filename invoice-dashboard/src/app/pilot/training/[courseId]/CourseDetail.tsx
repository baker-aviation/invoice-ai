"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Course = {
  id: number;
  title: string;
  description: string | null;
  status: string;
};

type Module = {
  id: number;
  course_id: number;
  title: string;
  sort_order: number;
};

type Lesson = {
  id: number;
  module_id: number;
  title: string;
  lesson_type: string;
  sort_order: number;
};

const LESSON_TYPE_ICONS: Record<string, string> = {
  video: "▶",
  document: "📄",
  quiz: "❓",
  text: "📝",
};

export default function CourseDetail({
  course,
  modules,
  lessons,
  completedLessonIds,
  isAdmin,
}: {
  course: Record<string, unknown>;
  modules: Record<string, unknown>[];
  lessons: Record<string, unknown>[];
  completedLessonIds: number[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const c = course as unknown as Course;
  const mods = modules as unknown as Module[];
  const lsns = lessons as unknown as Lesson[];
  const completedSet = new Set(completedLessonIds);

  const [showAddModule, setShowAddModule] = useState(false);
  const [showAddLesson, setShowAddLesson] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);

  async function togglePublish() {
    setPublishing(true);
    try {
      await fetch(`/api/pilot/training/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: c.status === "published" ? "draft" : "published",
        }),
      });
      router.refresh();
    } finally {
      setPublishing(false);
    }
  }

  const totalLessons = lsns.length;
  const completedCount = lsns.filter((l) => completedSet.has(l.id)).length;
  const pct = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

  return (
    <div>
      <Link
        href="/pilot/training"
        className="text-sm text-blue-700 hover:underline mb-4 inline-block"
      >
        ← Back to Training
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{c.title}</h1>
          {c.description && (
            <p className="text-sm text-gray-500 mt-1">{c.description}</p>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={togglePublish}
              disabled={publishing}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                c.status === "published"
                  ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
                  : "bg-green-100 text-green-800 hover:bg-green-200"
              }`}
            >
              {c.status === "published" ? "Unpublish" : "Publish"}
            </button>
            <button
              onClick={() => setShowAddModule(true)}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 transition-colors"
            >
              + Module
            </button>
          </div>
        )}
      </div>

      {/* Progress bar for pilots */}
      {!isAdmin && totalLessons > 0 && (
        <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
            <span>
              {completedCount}/{totalLessons} lessons completed
            </span>
            <span className="font-medium">{pct}%</span>
          </div>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Modules & lessons tree */}
      {mods.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          {isAdmin
            ? "No modules yet. Add one to get started."
            : "This course has no content yet."}
        </div>
      ) : (
        <div className="space-y-4">
          {mods.map((mod) => {
            const modLessons = lsns
              .filter((l) => l.module_id === mod.id)
              .sort((a, b) => a.sort_order - b.sort_order);

            return (
              <div
                key={mod.id}
                className="bg-white border border-gray-200 rounded-lg overflow-hidden"
              >
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="font-medium text-sm text-gray-900">
                    {mod.title}
                  </h3>
                  {isAdmin && (
                    <button
                      onClick={() => setShowAddLesson(mod.id)}
                      className="text-[11px] text-blue-700 hover:underline"
                    >
                      + Lesson
                    </button>
                  )}
                </div>
                {modLessons.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-gray-400">
                    No lessons in this module.
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {modLessons.map((lesson) => {
                      const done = completedSet.has(lesson.id);
                      return (
                        <li key={lesson.id}>
                          <Link
                            href={`/pilot/training/${c.id}/${lesson.id}`}
                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors"
                          >
                            <span className="text-sm">
                              {LESSON_TYPE_ICONS[lesson.lesson_type] || "📝"}
                            </span>
                            <span className="text-sm text-gray-800 flex-1">
                              {lesson.title}
                            </span>
                            <span className="text-[10px] text-gray-400 uppercase">
                              {lesson.lesson_type}
                            </span>
                            {!isAdmin && (
                              <span
                                className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                                  done
                                    ? "bg-green-100 text-green-700"
                                    : "bg-gray-100 text-gray-400"
                                }`}
                              >
                                {done ? "✓" : "○"}
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAddModule && (
        <AddModuleModal
          courseId={c.id}
          nextOrder={mods.length}
          onClose={() => setShowAddModule(false)}
        />
      )}

      {showAddLesson !== null && (
        <AddLessonModal
          courseId={c.id}
          moduleId={showAddLesson}
          nextOrder={
            lsns.filter((l) => l.module_id === showAddLesson).length
          }
          onClose={() => setShowAddLesson(null)}
        />
      )}
    </div>
  );
}

function AddModuleModal({
  courseId,
  nextOrder,
  onClose,
}: {
  courseId: number;
  nextOrder: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/pilot/training/${courseId}/modules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), sort_order: nextOrder }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to create module");
        setSubmitting(false);
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[24rem] max-w-[95vw] p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-4">
          Add Module
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Module title"
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
            autoFocus
          />
          {error && (
            <div className="text-xs text-red-600">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Adding..." : "Add Module"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddLessonModal({
  courseId,
  moduleId,
  nextOrder,
  onClose,
}: {
  courseId: number;
  moduleId: number;
  nextOrder: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [lessonType, setLessonType] = useState("text");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/pilot/training/${courseId}/modules/${moduleId}/lessons`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            lesson_type: lessonType,
            sort_order: nextOrder,
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to create lesson");
        setSubmitting(false);
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[24rem] max-w-[95vw] p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-4">
          Add Lesson
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Lesson title"
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400"
            autoFocus
          />
          <select
            value={lessonType}
            onChange={(e) => setLessonType(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 bg-white"
          >
            <option value="text">Text</option>
            <option value="video">Video</option>
            <option value="document">Document</option>
            <option value="quiz">Quiz</option>
          </select>
          {error && (
            <div className="text-xs text-red-600">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Adding..." : "Add Lesson"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
