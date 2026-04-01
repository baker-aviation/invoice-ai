import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/jetinsight/documents — Query JetInsight documents with filters
 * Query params: entity_type, entity_id, category
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const entityType = req.nextUrl.searchParams.get("entity_type");
  const entityId = req.nextUrl.searchParams.get("entity_id");
  const category = req.nextUrl.searchParams.get("category");
  const withUrls = req.nextUrl.searchParams.get("with_urls") !== "false";

  const supa = createServiceClient();
  let query = supa
    .from("jetinsight_documents")
    .select("*")
    .order("category")
    .order("created_at", { ascending: false });

  if (entityType) query = query.eq("entity_type", entityType);
  if (entityId) query = query.eq("entity_id", entityId);
  if (category) query = query.eq("category", category);

  const { data, error } = await query;

  if (error) {
    console.error("[jetinsight/documents] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 },
    );
  }

  // Optionally sign GCS URLs for download
  if (withUrls && data) {
    for (const doc of data) {
      doc.signed_url = await signGcsUrl(doc.gcs_bucket, doc.gcs_key, 120);
    }
  }

  return NextResponse.json({ documents: data });
}
