import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PIPELINE_STAGES } from "@/lib/types";

const SAFE_ID_RE = /^\d+$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  if (!SAFE_ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  let body: { stage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stage = body.stage;
  if (!stage || !(PIPELINE_STAGES as readonly string[]).includes(stage)) {
    return NextResponse.json(
      { error: `Invalid stage. Must be one of: ${PIPELINE_STAGES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const supa = createServiceClient();
    const { data } = await supa
      .from("job_application_parse")
      .update({ pipeline_stage: stage })
      .eq("application_id", Number(id))
      .select("id");

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, stage });
  } catch (err) {
    console.error("[jobs/stage] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
