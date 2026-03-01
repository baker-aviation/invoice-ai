import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PIPELINE_STAGES } from "@/lib/types";

const CATEGORIES = [
  "pilot_pic", "pilot_sic", "dispatcher", "maintenance",
  "sales", "hr", "admin", "management", "line_service", "other",
] as const;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = String(body.candidate_name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "candidate_name is required" }, { status: 400 });
  }

  const category = body.category ?? null;
  if (category && !(CATEGORIES as readonly string[]).includes(category)) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  const stage = body.pipeline_stage ?? "new";
  if (!(PIPELINE_STAGES as readonly string[]).includes(stage)) {
    return NextResponse.json({ error: "Invalid pipeline_stage" }, { status: 400 });
  }

  try {
    const supa = createServiceClient();

    // 1. Create a parent job_applications row
    const { data: appRow, error: appErr } = await supa
      .from("job_applications")
      .insert({
        mailbox: "manual-entry",
        role_bucket: category ?? "other",
        subject: `Manual entry: ${name}`,
        received_at: new Date().toISOString(),
        source_message_id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      })
      .select("id")
      .single();

    if (appErr || !appRow) {
      console.error("[jobs/create] Failed to create job_applications row:", appErr);
      return NextResponse.json({ error: "Failed to create application" }, { status: 500 });
    }

    // 2. Create the parse row with candidate info
    const { data: parseRow, error: parseErr } = await supa
      .from("job_application_parse")
      .insert({
        application_id: appRow.id,
        candidate_name: name,
        email: String(body.email ?? "").trim() || null,
        phone: String(body.phone ?? "").trim() || null,
        location: String(body.location ?? "").trim() || null,
        category: category,
        employment_type: body.employment_type ?? null,
        total_time_hours: body.total_time_hours ?? null,
        pic_time_hours: body.pic_time_hours ?? null,
        pipeline_stage: stage,
        notes: String(body.notes ?? "").trim() || null,
        needs_review: false,
        model: "manual",
      })
      .select("id, application_id")
      .single();

    if (parseErr || !parseRow) {
      console.error("[jobs/create] Failed to create parse row:", parseErr);
      return NextResponse.json({ error: "Failed to create candidate record" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      application_id: parseRow.application_id,
      id: parseRow.id,
    });
  } catch (err) {
    console.error("[jobs/create] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
