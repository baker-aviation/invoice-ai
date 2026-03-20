import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/intl/trip-docs?tail=N954JS
 *
 * Returns a list of available documents (aircraft + company) with
 * signed download URLs. The client uses these to build a ZIP.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tail = req.nextUrl.searchParams.get("tail")?.toUpperCase();
  if (!tail) {
    return NextResponse.json({ error: "tail parameter required" }, { status: 400 });
  }

  // Optional: comma-separated doc IDs to generate URLs for
  const ids = req.nextUrl.searchParams.get("ids")?.split(",").filter(Boolean);

  const supa = createServiceClient();
  const storage = await getGcsStorage();

  // If specific IDs requested, fetch just those
  if (ids && ids.length > 0) {
    const { data: docs } = await supa
      .from("intl_documents")
      .select("id, name, document_type, entity_type, entity_id, gcs_bucket, gcs_key, filename")
      .in("id", ids)
      .eq("is_current", true);

    const results = await Promise.all(
      (docs ?? []).map(async (doc) => {
        try {
          const bucket = storage.bucket(doc.gcs_bucket);
          const file = bucket.file(doc.gcs_key);
          const [url] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 30 * 60 * 1000,
            responseDisposition: `attachment; filename="${doc.name}.pdf"`,
            responseType: "application/pdf",
          });
          return { ...doc, url };
        } catch {
          return { ...doc, url: null };
        }
      })
    );

    return NextResponse.json({ documents: results.filter((d) => d.url) });
  }

  // Otherwise return document list (no URLs yet — client picks first)
  const [aircraftRes, companyRes] = await Promise.all([
    supa
      .from("intl_documents")
      .select("id, name, document_type, entity_type, entity_id")
      .eq("entity_type", "aircraft")
      .eq("entity_id", tail)
      .eq("is_current", true)
      .order("name"),
    supa
      .from("intl_documents")
      .select("id, name, document_type, entity_type, entity_id")
      .eq("entity_type", "company")
      .eq("entity_id", "baker_aviation")
      .eq("is_current", true)
      .order("name"),
  ]);

  return NextResponse.json({
    aircraft: aircraftRes.data ?? [],
    company: companyRes.data ?? [],
  });
}
