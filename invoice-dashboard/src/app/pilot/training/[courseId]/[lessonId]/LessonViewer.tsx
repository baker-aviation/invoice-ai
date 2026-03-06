"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import RichTextEditor, { type RichTextEditorHandle } from "@/components/RichTextEditor";
import SafeHTML from "@/components/SafeHTML";

type Lesson = {
  id: number;
  module_id: number;
  title: string;
  lesson_type: string;
  content_html: string | null;
  video_filename: string | null;
  doc_filename: string | null;
};

type QuizQuestion = {
  id: number;
  question: string;
  options: string[];
  correct_answer?: number; // only present for admins
};

export default function LessonViewer({
  courseId,
  courseTitle,
  lesson,
  videoUrl,
  docUrl,
  quizQuestions,
  isCompleted: initialCompleted,
  isAdmin,
  prevLessonId,
  nextLessonId,
}: {
  courseId: number;
  courseTitle: string;
  lesson: Record<string, unknown>;
  videoUrl: string | null;
  docUrl: string | null;
  quizQuestions: Record<string, unknown>[];
  isCompleted: boolean;
  isAdmin: boolean;
  prevLessonId: number | null;
  nextLessonId: number | null;
}) {
  const router = useRouter();
  const l = lesson as unknown as Lesson;
  const questions = quizQuestions as unknown as QuizQuestion[];

  const [completed, setCompleted] = useState(initialCompleted);
  const [marking, setMarking] = useState(false);

  // Quiz state (pilot)
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [quizResult, setQuizResult] = useState<{
    score: number;
    total: number;
    passed: boolean;
    results: { question_id: number; is_correct: boolean }[];
  } | null>(null);
  const [submittingQuiz, setSubmittingQuiz] = useState(false);

  // Admin edit state
  const [editing, setEditing] = useState(false);

  async function handleMarkComplete() {
    setMarking(true);
    try {
      const res = await fetch(
        `/api/pilot/training/${courseId}/modules/${l.module_id}/lessons/${l.id}/progress`,
        { method: "POST" }
      );
      if (res.ok) {
        setCompleted(true);
      }
    } finally {
      setMarking(false);
    }
  }

  async function handleSubmitQuiz() {
    if (Object.keys(answers).length < questions.length) return;
    setSubmittingQuiz(true);
    try {
      const res = await fetch(
        `/api/pilot/training/${courseId}/modules/${l.module_id}/lessons/${l.id}/quiz`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setQuizResult(data);
        if (data.passed) {
          setCompleted(true);
        }
      }
    } finally {
      setSubmittingQuiz(false);
    }
  }

  return (
    <div>
      <Link
        href={`/pilot/training/${courseId}`}
        className="text-sm text-blue-700 hover:underline mb-4 inline-block"
      >
        &larr; {courseTitle}
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{l.title}</h1>
          <span className="text-xs text-gray-400 uppercase">
            {l.lesson_type}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && (
            <button
              onClick={() => setEditing((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                editing
                  ? "border-blue-400 bg-blue-50 text-blue-700"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {editing ? "Done Editing" : "Edit"}
            </button>
          )}
          {!isAdmin && !completed && l.lesson_type !== "quiz" && (
            <button
              onClick={handleMarkComplete}
              disabled={marking}
              className="px-4 py-2 text-sm font-medium text-white bg-green-700 rounded-lg hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {marking ? "Saving..." : "Mark Complete"}
            </button>
          )}
          {!isAdmin && completed && (
            <span className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-green-800 bg-green-100 rounded-lg">
              &#10003; Completed
            </span>
          )}
        </div>
      </div>

      {/* Admin Edit Panel */}
      {isAdmin && editing && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-5 mb-6">
          {l.lesson_type === "text" && (
            <TextEditor courseId={courseId} lesson={l} />
          )}
          {l.lesson_type === "video" && (
            <VideoEditor courseId={courseId} lesson={l} />
          )}
          {l.lesson_type === "document" && (
            <DocumentEditor courseId={courseId} lesson={l} />
          )}
          {l.lesson_type === "quiz" && (
            <QuizEditor courseId={courseId} lesson={l} questions={questions} />
          )}
        </div>
      )}

      {/* Content area */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        {/* Video */}
        {l.lesson_type === "video" && videoUrl && (
          <video
            src={videoUrl}
            controls
            className="w-full max-w-3xl mx-auto rounded-lg"
          />
        )}
        {l.lesson_type === "video" && !videoUrl && (
          <div className="text-center py-12 text-gray-400 text-sm">
            No video uploaded yet.
          </div>
        )}

        {/* Document */}
        {l.lesson_type === "document" && docUrl && (
          <div className="text-center">
            <iframe
              src={docUrl}
              className="w-full h-[600px] border border-gray-200 rounded-lg"
              title={l.title}
            />
            <a
              href={docUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-3 text-sm text-blue-700 hover:underline"
            >
              Open in new tab
            </a>
          </div>
        )}
        {l.lesson_type === "document" && !docUrl && (
          <div className="text-center py-12 text-gray-400 text-sm">
            No document uploaded yet.
          </div>
        )}

        {/* Text */}
        {l.lesson_type === "text" && l.content_html && (
          <SafeHTML
            html={l.content_html}
            className="prose prose-sm max-w-none"
          />
        )}
        {l.lesson_type === "text" && !l.content_html && (
          <div className="text-center py-12 text-gray-400 text-sm">
            No content yet.
          </div>
        )}

        {/* Quiz */}
        {l.lesson_type === "quiz" && (
          <div>
            {questions.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-sm">
                No quiz questions yet.
              </div>
            ) : (
              <div className="space-y-6">
                {questions.map((q, qi) => {
                  const resultItem = quizResult?.results.find(
                    (r) => r.question_id === q.id
                  );
                  return (
                    <div key={q.id}>
                      <p className="font-medium text-sm text-gray-900 mb-2">
                        {qi + 1}. {q.question}
                      </p>
                      <div className="space-y-1.5">
                        {q.options.map((opt, oi) => {
                          const selected = answers[q.id] === oi;
                          let extraClass = "";
                          if (quizResult && resultItem) {
                            if (selected && resultItem.is_correct)
                              extraClass = "border-green-400 bg-green-50";
                            else if (selected && !resultItem.is_correct)
                              extraClass = "border-red-400 bg-red-50";
                          }
                          return (
                            <label
                              key={oi}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                                selected && !quizResult
                                  ? "border-blue-400 bg-blue-50"
                                  : extraClass || "border-gray-200 hover:border-gray-300"
                              }`}
                            >
                              <input
                                type="radio"
                                name={`q-${q.id}`}
                                checked={selected}
                                onChange={() =>
                                  setAnswers((prev) => ({
                                    ...prev,
                                    [q.id]: oi,
                                  }))
                                }
                                disabled={!!quizResult}
                                className="accent-blue-600"
                              />
                              <span className="text-sm text-gray-700">
                                {opt}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {!quizResult && !isAdmin && (
                  <button
                    onClick={handleSubmitQuiz}
                    disabled={
                      submittingQuiz ||
                      Object.keys(answers).length < questions.length
                    }
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
                  >
                    {submittingQuiz ? "Submitting..." : "Submit Quiz"}
                  </button>
                )}

                {quizResult && (
                  <div
                    className={`p-4 rounded-lg border ${
                      quizResult.passed
                        ? "bg-green-50 border-green-200"
                        : "bg-red-50 border-red-200"
                    }`}
                  >
                    <p className="font-medium text-sm">
                      Score: {quizResult.score}/{quizResult.total} (
                      {Math.round(
                        (quizResult.score / quizResult.total) * 100
                      )}
                      %)
                    </p>
                    <p className="text-sm mt-1">
                      {quizResult.passed
                        ? "Passed! This lesson has been marked complete."
                        : "Did not pass (80% required). You can retake the quiz."}
                    </p>
                    {!quizResult.passed && (
                      <button
                        onClick={() => {
                          setQuizResult(null);
                          setAnswers({});
                        }}
                        className="mt-2 text-sm text-blue-700 hover:underline"
                      >
                        Retake Quiz
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Prev/Next navigation */}
      <div className="flex items-center justify-between">
        {prevLessonId ? (
          <Link
            href={`/pilot/training/${courseId}/${prevLessonId}`}
            className="text-sm text-blue-700 hover:underline"
          >
            &larr; Previous Lesson
          </Link>
        ) : (
          <span />
        )}
        {nextLessonId ? (
          <Link
            href={`/pilot/training/${courseId}/${nextLessonId}`}
            className="text-sm text-blue-700 hover:underline"
          >
            Next Lesson &rarr;
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text Editor (rich text with contentEditable)
// ---------------------------------------------------------------------------
function TextEditor({ courseId, lesson }: { courseId: number; lesson: Lesson }) {
  const router = useRouter();
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/pilot/training/${courseId}/modules/${lesson.module_id}/lessons/${lesson.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content_html: editorRef.current?.getHTML() ?? "" }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save");
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-2">
        Text Content
      </label>
      <RichTextEditor
        ref={editorRef}
        initialHTML={lesson.content_html ?? ""}
        placeholder="Lesson content..."
      />
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
      <button
        onClick={handleSave}
        disabled={saving}
        className="mt-3 px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving..." : "Save Content"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video Editor (presigned upload)
// ---------------------------------------------------------------------------
function VideoEditor({ courseId, lesson }: { courseId: number; lesson: Lesson }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError("");
    setProgress("Getting upload URL...");
    try {
      const res = await fetch(
        `/api/pilot/training/${courseId}/modules/${lesson.module_id}/lessons/${lesson.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_filename: file.name }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to get upload URL");
        setUploading(false);
        setProgress("");
        return;
      }

      const { upload_url } = await res.json();
      if (!upload_url) {
        setError("No upload URL returned");
        setUploading(false);
        setProgress("");
        return;
      }

      setProgress("Uploading video...");
      const ext = file.name.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "mp4" ? "video/mp4" : ext === "m4v" ? "video/x-m4v" : "video/quicktime";

      const uploadRes = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });

      if (!uploadRes.ok) {
        setError("Video upload failed. Please try again.");
        setUploading(false);
        setProgress("");
        return;
      }

      setProgress("Done!");
      setFile(null);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-2">
        Video {lesson.video_filename ? `(current: ${lesson.video_filename})` : ""}
      </label>
      <input
        type="file"
        accept=".mov,.mp4,.m4v"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
      />
      <p className="text-[10px] text-gray-400 mt-1">.mov, .mp4, .m4v</p>
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
      {progress && <div className="text-xs text-blue-600 mt-1">{progress}</div>}
      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="mt-3 px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
      >
        {uploading ? "Uploading..." : "Upload Video"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document Editor (presigned upload)
// ---------------------------------------------------------------------------
function DocumentEditor({ courseId, lesson }: { courseId: number; lesson: Lesson }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError("");
    setProgress("Getting upload URL...");
    try {
      const res = await fetch(
        `/api/pilot/training/${courseId}/modules/${lesson.module_id}/lessons/${lesson.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc_filename: file.name }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to get upload URL");
        setUploading(false);
        setProgress("");
        return;
      }

      const { upload_url } = await res.json();
      if (!upload_url) {
        setError("No upload URL returned");
        setUploading(false);
        setProgress("");
        return;
      }

      setProgress("Uploading document...");
      const ext = file.name.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "pdf" ? "application/pdf"
        : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";

      const uploadRes = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });

      if (!uploadRes.ok) {
        setError("Document upload failed. Please try again.");
        setUploading(false);
        setProgress("");
        return;
      }

      setProgress("Done!");
      setFile(null);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-2">
        Document {lesson.doc_filename ? `(current: ${lesson.doc_filename})` : ""}
      </label>
      <input
        type="file"
        accept=".pdf,.docx,.doc"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
      />
      <p className="text-[10px] text-gray-400 mt-1">.pdf, .docx, .doc</p>
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
      {progress && <div className="text-xs text-blue-600 mt-1">{progress}</div>}
      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="mt-3 px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
      >
        {uploading ? "Uploading..." : "Upload Document"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quiz Editor (add/edit/delete questions)
// ---------------------------------------------------------------------------
function QuizEditor({
  courseId,
  lesson,
  questions: initialQuestions,
}: {
  courseId: number;
  lesson: Lesson;
  questions: QuizQuestion[];
}) {
  const router = useRouter();
  const apiBase = `/api/pilot/training/${courseId}/modules/${lesson.module_id}/lessons/${lesson.id}/quiz`;

  // Editable copies of existing questions
  const [editedQuestions, setEditedQuestions] = useState(
    initialQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      options: [...q.options, ...Array(Math.max(0, 4 - q.options.length)).fill("")].slice(0, 4),
      correct_answer: q.correct_answer ?? 0,
    }))
  );
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  // New question form
  const [newQuestion, setNewQuestion] = useState("");
  const [newOptions, setNewOptions] = useState(["", "", "", ""]);
  const [newCorrect, setNewCorrect] = useState(0);
  const [adding, setAdding] = useState(false);

  function updateEdited(id: number, field: string, value: unknown) {
    setEditedQuestions((prev) =>
      prev.map((q) => (q.id === id ? { ...q, [field]: value } : q))
    );
  }

  function updateEditedOption(id: number, optIdx: number, value: string) {
    setEditedQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== id) return q;
        const opts = [...q.options];
        opts[optIdx] = value;
        return { ...q, options: opts };
      })
    );
  }

  async function handleSaveQuestion(q: (typeof editedQuestions)[0]) {
    setSavingId(q.id);
    setError("");
    try {
      const options = q.options.filter((o) => o.trim());
      if (options.length < 2) {
        setError("At least 2 options required");
        setSavingId(null);
        return;
      }
      const res = await fetch(`${apiBase}/${q.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q.question,
          options,
          correct_answer: q.correct_answer,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save");
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteQuestion(qId: number) {
    if (!confirm("Delete this question?")) return;
    setDeletingId(qId);
    setError("");
    try {
      const res = await fetch(`${apiBase}/${qId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to delete");
      } else {
        setEditedQuestions((prev) => prev.filter((q) => q.id !== qId));
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleAddQuestion() {
    if (!newQuestion.trim()) return;
    const options = newOptions.filter((o) => o.trim());
    if (options.length < 2) {
      setError("At least 2 options required");
      return;
    }
    setAdding(true);
    setError("");
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: newQuestion.trim(),
          options,
          correct_answer: newCorrect,
          sort_order: editedQuestions.length,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to add question");
      } else {
        const data = await res.json();
        setEditedQuestions((prev) => [
          ...prev,
          {
            id: data.question.id,
            question: data.question.question,
            options: [...data.question.options, ...Array(Math.max(0, 4 - data.question.options.length)).fill("")].slice(0, 4),
            correct_answer: data.question.correct_answer,
          },
        ]);
        setNewQuestion("");
        setNewOptions(["", "", "", ""]);
        setNewCorrect(0);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-3">
        Quiz Questions
      </label>

      {error && <div className="text-xs text-red-600 mb-3">{error}</div>}

      {/* Existing questions */}
      <div className="space-y-4 mb-6">
        {editedQuestions.map((q, qi) => (
          <div key={q.id} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-xs font-medium text-gray-500 shrink-0 mt-1">Q{qi + 1}</span>
              <input
                value={q.question}
                onChange={(e) => updateEdited(q.id, "question", e.target.value)}
                className="flex-1 rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-gray-400"
                placeholder="Question text"
              />
            </div>
            <div className="space-y-1.5 ml-6">
              {q.options.map((opt, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`eq-${q.id}`}
                    checked={q.correct_answer === oi}
                    onChange={() => updateEdited(q.id, "correct_answer", oi)}
                    className="accent-green-600"
                    title="Mark as correct answer"
                  />
                  <input
                    value={opt}
                    onChange={(e) => updateEditedOption(q.id, oi, e.target.value)}
                    className="flex-1 rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-gray-400"
                    placeholder={`Option ${oi + 1}`}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-3 ml-6">
              <button
                onClick={() => handleSaveQuestion(q)}
                disabled={savingId === q.id}
                className="px-3 py-1 text-xs font-medium text-white bg-blue-900 rounded hover:bg-blue-800 disabled:opacity-50 transition-colors"
              >
                {savingId === q.id ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => handleDeleteQuestion(q.id)}
                disabled={deletingId === q.id}
                className="px-3 py-1 text-xs font-medium text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {deletingId === q.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add new question */}
      <div className="bg-white border border-dashed border-gray-300 rounded-lg p-4">
        <div className="text-xs font-medium text-gray-500 mb-2">Add Question</div>
        <input
          value={newQuestion}
          onChange={(e) => setNewQuestion(e.target.value)}
          className="w-full rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-gray-400 mb-2"
          placeholder="Question text"
        />
        <div className="space-y-1.5 mb-3">
          {newOptions.map((opt, oi) => (
            <div key={oi} className="flex items-center gap-2">
              <input
                type="radio"
                name="new-q-correct"
                checked={newCorrect === oi}
                onChange={() => setNewCorrect(oi)}
                className="accent-green-600"
                title="Mark as correct answer"
              />
              <input
                value={opt}
                onChange={(e) => {
                  const opts = [...newOptions];
                  opts[oi] = e.target.value;
                  setNewOptions(opts);
                }}
                className="flex-1 rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-gray-400"
                placeholder={`Option ${oi + 1}`}
              />
            </div>
          ))}
        </div>
        <button
          onClick={handleAddQuestion}
          disabled={adding || !newQuestion.trim()}
          className="px-4 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
        >
          {adding ? "Adding..." : "Add Question"}
        </button>
      </div>
    </div>
  );
}
