import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
  citation_x: "Citation X",
  challenger_300: "Challenger 300",
};

/**
 * GET /api/pilot/bulletins — list bulletins
 * Optional ?category= filter
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const category = req.nextUrl.searchParams.get("category");
  const supa = createServiceClient();

  let query = supa
    .from("pilot_bulletins")
    .select("id, title, summary, category, published_at, created_at, pilot_bulletin_attachments(id, filename, content_type)")
    .order("published_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[pilot/bulletins] list error:", error);
    return NextResponse.json({ error: "Failed to list bulletins" }, { status: 500 });
  }

  return NextResponse.json({ bulletins: data });
}

/**
 * POST /api/pilot/bulletins — create a bulletin (admin only)
 * JSON body: { title, summary?, category }
 *
 * All attachments (videos, PDFs, images) are added via
 * POST /api/pilot/bulletins/[id]/attachments after creation.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { title?: string; summary?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = body.title?.trim();
  const summary = body.summary?.trim() || null;
  const category = body.category?.trim();

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!category || !CATEGORY_LABELS[category]) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: bulletin, error: dbErr } = await supa
    .from("pilot_bulletins")
    .insert({
      title,
      summary,
      category,
      created_by: auth.userId,
    })
    .select("id, title, summary, category, published_at")
    .single();

  if (dbErr) {
    console.error("[pilot/bulletins] insert error:", dbErr);
    return NextResponse.json({ error: `Failed to create bulletin: ${dbErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ bulletin }, { status: 201 });
}
