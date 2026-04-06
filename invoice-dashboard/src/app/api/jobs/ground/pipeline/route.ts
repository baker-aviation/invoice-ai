import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { fetchGroundPipelineJobs } from "@/lib/groundJobApi";

/** GET /api/jobs/ground/pipeline — fetch all ground pipeline candidates */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const result = await fetchGroundPipelineJobs();
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[ground/pipeline] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
