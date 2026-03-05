"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Lesson = {
  id: number;
  module_id: number;
  title: string;
  lesson_type: string;
  content_html: string | null;
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

  // Quiz state
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [quizResult, setQuizResult] = useState<{
    score: number;
    total: number;
    passed: boolean;
    results: { question_id: number; is_correct: boolean }[];
  } | null>(null);
  const [submittingQuiz, setSubmittingQuiz] = useState(false);

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
        ← {courseTitle}
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{l.title}</h1>
          <span className="text-xs text-gray-400 uppercase">
            {l.lesson_type}
          </span>
        </div>
        {!isAdmin && !completed && l.lesson_type !== "quiz" && (
          <button
            onClick={handleMarkComplete}
            disabled={marking}
            className="px-4 py-2 text-sm font-medium text-white bg-green-700 rounded-lg hover:bg-green-600 disabled:opacity-50 transition-colors shrink-0"
          >
            {marking ? "Saving..." : "Mark Complete"}
          </button>
        )}
        {!isAdmin && completed && (
          <span className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-green-800 bg-green-100 rounded-lg shrink-0">
            ✓ Completed
          </span>
        )}
      </div>

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
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: l.content_html }}
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
            ← Previous Lesson
          </Link>
        ) : (
          <span />
        )}
        {nextLessonId ? (
          <Link
            href={`/pilot/training/${courseId}/${nextLessonId}`}
            className="text-sm text-blue-700 hover:underline"
          >
            Next Lesson →
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
