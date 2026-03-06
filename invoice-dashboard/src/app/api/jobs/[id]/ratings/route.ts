import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * PATCH /api/jobs/[id]/ratings — admin override for type ratings
 *
 * [id] = application_id
 *
 * Body: {
 *   type_ratings?: string[],
 *   has_citation_x?: boolean,
 *   has_challenger_300_type_rating?: boolean,
 * }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId)) {
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

  if ("type_ratings" in body) {
    if (!Array.isArray(body.type_ratings) || !body.type_ratings.every((r) => typeof r === "string")) {
      return NextResponse.json({ error: "type_ratings must be a string array" }, { status: 400 });
    }
    update.type_ratings = body.type_ratings;
  }

  if ("has_citation_x" in body) {
    if (typeof body.has_citation_x !== "boolean" && body.has_citation_x !== null) {
      return NextResponse.json({ error: "has_citation_x must be boolean or null" }, { status: 400 });
    }
    update.has_citation_x = body.has_citation_x;
  }

  if ("has_challenger_300_type_rating" in body) {
    if (typeof body.has_challenger_300_type_rating !== "boolean" && body.has_challenger_300_type_rating !== null) {
      return NextResponse.json({ error: "has_challenger_300_type_rating must be boolean or null" }, { status: 400 });
    }
    update.has_challenger_300_type_rating = body.has_challenger_300_type_rating;
  }

  const validCategories = [
    "pilot_pic", "pilot_sic", "skillbridge", "dispatcher", "maintenance",
    "sales", "hr", "admin", "management", "line_service", "other",
  ];
  if ("category" in body) {
    if (typeof body.category !== "string" || !validCategories.includes(body.category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    update.category = body.category;
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
    return NextResponse.json({ error: "Failed to update ratings" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
