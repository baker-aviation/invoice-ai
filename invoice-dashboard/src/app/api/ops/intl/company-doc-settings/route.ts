import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

/**
 * GET /api/ops/intl/company-doc-settings — Get all company docs + which are selected for intl trips
 * PUT /api/ops/intl/company-doc-settings — Update the selected doc IDs
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();

  // Get all company docs
  const { data: docs } = await supa
    .from("jetinsight_documents")
    .select("id, category, document_name")
    .eq("entity_type", "company")
    .eq("entity_id", "baker_aviation")
    .order("category");

  // Get current selection
  const { data: setting } = await supa
    .from("app_settings")
    .select("value")
    .eq("key", "intl_company_doc_ids")
    .maybeSingle();

  let selectedIds: number[] = [];
  if (setting?.value) {
    try { selectedIds = JSON.parse(setting.value); } catch { /* */ }
  }

  return NextResponse.json({ docs: docs ?? [], selectedIds });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: { selectedIds?: number[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.selectedIds ?? [];
  const supa = createServiceClient();

  await supa.from("app_settings").upsert(
    { key: "intl_company_doc_ids", value: JSON.stringify(ids) },
    { onConflict: "key" },
  );

  return NextResponse.json({ ok: true, count: ids.length });
}
