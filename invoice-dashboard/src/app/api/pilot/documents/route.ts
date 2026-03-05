import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/documents — list documents (pilot-accessible)
 * Optional ?category= filter
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const category = req.nextUrl.searchParams.get("category");
  const supa = createServiceClient();

  let query = supa
    .from("pilot_documents")
    .select("id, title, description, category, filename, content_type, size_bytes, created_at")
    .order("created_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[pilot/documents] list error:", error);
    return NextResponse.json({ error: "Failed to list documents" }, { status: 500 });
  }

  return NextResponse.json({ documents: data });
}
