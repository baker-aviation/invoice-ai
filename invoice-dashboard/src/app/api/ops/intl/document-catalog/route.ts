import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/ops/intl/document-catalog?category=crew|aircraft|company|trip
 *
 * Returns distinct document categories and names from jetinsight_documents
 * for use as suggestions in the document rules UI.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const category = req.nextUrl.searchParams.get("category");
  const supa = createServiceClient();

  // Map our doc_category to entity_type
  const entityType = category === "trip" ? "trip" : category === "crew" ? "crew" : category === "aircraft" ? "aircraft" : category === "company" ? "company" : null;

  if (!entityType) {
    return NextResponse.json({ error: "category required (trip, crew, aircraft, company)" }, { status: 400 });
  }

  // Get distinct categories from jetinsight_documents
  const { data: jiDocs } = await supa
    .from("jetinsight_documents")
    .select("category, document_name")
    .eq("entity_type", entityType)
    .limit(500);

  // Also get from intl_documents if aircraft or company
  let intlNames: string[] = [];
  if (entityType === "aircraft" || entityType === "company") {
    const { data: intlDocs } = await supa
      .from("intl_documents")
      .select("name")
      .eq("entity_type", entityType)
      .eq("is_current", true);
    intlNames = [...new Set((intlDocs ?? []).map((d) => d.name))];
  }

  // Build distinct categories and sample names
  const categoryMap = new Map<string, Set<string>>();
  for (const d of jiDocs ?? []) {
    if (!categoryMap.has(d.category)) categoryMap.set(d.category, new Set());
    categoryMap.get(d.category)!.add(d.document_name);
  }

  // For crew, the document_name is usually the person's name — not useful as suggestion
  // Use categories instead as the main suggestions
  const categories = [...categoryMap.keys()].sort();

  // For aircraft/company/trip, document_name is more useful
  // Dedupe and clean up names (remove tail numbers for aircraft)
  let sampleNames: string[] = [];
  if (entityType === "aircraft") {
    const names = new Set<string>();
    for (const d of jiDocs ?? []) {
      // Strip tail number prefix: "N955GH Airworthiness Certificate" → "Airworthiness Certificate"
      const cleaned = d.document_name.replace(/^N\d{1,5}[A-Z]{0,2}\s+/i, "").trim();
      if (cleaned) names.add(cleaned);
    }
    sampleNames = [...names].sort();
  } else if (entityType === "company" || entityType === "trip") {
    sampleNames = [...new Set((jiDocs ?? []).map((d) => d.document_name))].sort();
  }

  // Merge intl_documents names
  for (const name of intlNames) {
    const cleaned = name.replace(/^N\d{1,5}[A-Z]{0,2}\s+/i, "").trim();
    if (cleaned && !sampleNames.includes(cleaned)) sampleNames.push(cleaned);
  }

  return NextResponse.json({
    categories,
    sampleNames: sampleNames.slice(0, 100),
    totalDocs: (jiDocs ?? []).length + intlNames.length,
  });
}
