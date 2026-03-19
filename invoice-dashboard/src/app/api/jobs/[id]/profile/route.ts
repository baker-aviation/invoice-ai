import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const VALID_CATEGORIES = [
  "pilot_pic", "pilot_sic", "skillbridge", "dispatcher", "maintenance",
  "sales", "hr", "admin", "management", "line_service", "other",
];

const STRUCTURED_NOTE_KEYS = new Set([
  "hr_notes", "prd_review_notes", "tims_notes", "chief_pilot_notes",
]);

/**
 * PATCH /api/jobs/[id]/profile — update editable candidate fields
 * [id] = application_id
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // Boolean fields
  if ("needs_review" in body) {
    if (typeof body.needs_review !== "boolean") {
      return NextResponse.json({ error: "needs_review must be a boolean" }, { status: 400 });
    }
    update.needs_review = body.needs_review;
  }

  if ("hr_reviewed" in body) {
    if (typeof body.hr_reviewed !== "boolean") {
      return NextResponse.json({ error: "hr_reviewed must be a boolean" }, { status: 400 });
    }
    update.hr_reviewed = body.hr_reviewed;
  }

  // String fields
  const stringFields = ["candidate_name", "email", "phone", "location", "employment_type", "notes"] as const;
  for (const field of stringFields) {
    if (field in body) {
      if (body[field] !== null && typeof body[field] !== "string") {
        return NextResponse.json({ error: `${field} must be a string or null` }, { status: 400 });
      }
      update[field] = body[field] ?? null;
    }
  }

  // Category (validated against allowed list)
  if ("category" in body) {
    if (typeof body.category !== "string" || !VALID_CATEGORIES.includes(body.category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    update.category = body.category;
  }

  // Number fields (flight hours)
  const numberFields = ["total_time_hours", "pic_time_hours", "turbine_time_hours", "sic_time_hours"] as const;
  for (const field of numberFields) {
    if (field in body) {
      if (body[field] !== null && (typeof body[field] !== "number" || isNaN(body[field] as number))) {
        return NextResponse.json({ error: `${field} must be a number or null` }, { status: 400 });
      }
      update[field] = body[field] ?? null;
    }
  }

  // Structured notes
  if ("structured_notes" in body) {
    const sn = body.structured_notes;
    if (sn !== null) {
      if (typeof sn !== "object" || Array.isArray(sn)) {
        return NextResponse.json({ error: "structured_notes must be an object or null" }, { status: 400 });
      }
      for (const [key, val] of Object.entries(sn as Record<string, unknown>)) {
        if (!STRUCTURED_NOTE_KEYS.has(key)) {
          return NextResponse.json({ error: `Invalid structured_notes key: ${key}` }, { status: 400 });
        }
        if (typeof val !== "string" && val !== null) {
          return NextResponse.json({ error: `structured_notes.${key} must be a string or null` }, { status: 400 });
        }
      }
    }
    update.structured_notes = sn;
  }

  if (Object.keys(update).length <= 1) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("job_application_parse")
    .update(update)
    .eq("application_id", applicationId);

  if (error) {
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
