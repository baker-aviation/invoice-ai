import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { updateHiringStage, createCandidate } from "@/lib/jobApi";
import type { HiringStage } from "@/lib/types";

const VALID_STAGES: HiringStage[] = [
  "screening",
  "info_session",
  "tims_review",
  "prd_faa_review",
  "interview_scheduled",
  "interview_post",
  "pending_offer",
  "offer",
  "hired",
];

/** PATCH — move a candidate to a new hiring stage */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId))
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const { id, stage } = body as { id?: number; stage?: string };
  if (!id || typeof id !== "number")
    return NextResponse.json({ error: "Missing id (number)" }, { status: 400 });
  if (!stage || !VALID_STAGES.includes(stage as HiringStage))
    return NextResponse.json(
      { error: `Invalid stage. Must be one of: ${VALID_STAGES.join(", ")}` },
      { status: 400 },
    );

  try {
    await updateHiringStage(id, stage as HiringStage);
    return NextResponse.json({ ok: true, id, stage });
  } catch {
    return NextResponse.json({ error: "Failed to update hiring stage" }, { status: 500 });
  }
}

/** POST — create a new manual candidate */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId))
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const { candidate_name, email, phone, location, category, notes, hiring_stage } =
    body as Record<string, string | undefined>;

  if (!candidate_name?.trim())
    return NextResponse.json({ error: "candidate_name is required" }, { status: 400 });

  if (hiring_stage && !VALID_STAGES.includes(hiring_stage as HiringStage))
    return NextResponse.json(
      { error: `Invalid hiring_stage. Must be one of: ${VALID_STAGES.join(", ")}` },
      { status: 400 },
    );

  try {
    const row = await createCandidate({
      candidate_name: candidate_name.trim(),
      email: email?.trim(),
      phone: phone?.trim(),
      location: location?.trim(),
      category: category?.trim(),
      notes: notes?.trim(),
      hiring_stage: (hiring_stage as HiringStage) ?? undefined,
    });
    return NextResponse.json({ ok: true, job: row }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create candidate" }, { status: 500 });
  }
}
