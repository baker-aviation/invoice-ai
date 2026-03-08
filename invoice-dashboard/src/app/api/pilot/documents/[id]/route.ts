import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/pilot/documents/[id] — redirect to signed GCS URL for download/view
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const supa = createServiceClient();

  const { data: doc, error } = await supa
    .from("pilot_documents")
    .select("gcs_bucket, gcs_key, filename")
    .eq("id", id)
    .single();

  if (error || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const signed = await signGcsUrl(doc.gcs_bucket, doc.gcs_key, 120);
  if (!signed) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.redirect(signed, 302);
}
