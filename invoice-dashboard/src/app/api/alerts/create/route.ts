import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { presignUpload } from "@/lib/gcs-upload";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

const PARSER_BASE = process.env.PARSER_API_BASE_URL ?? process.env.INVOICE_PARSER_URL;

/**
 * POST /api/alerts/create
 * Create a manual alert from an uploaded PDF.
 *
 * Step 1 (action=presign): Get a presigned GCS upload URL
 *   Body: { action: "presign", filename: "invoice.pdf" }
 *   Returns: { bucket, key, url, contentType }
 *
 * Step 2 (action=create): After uploading to GCS, create the document + alert + trigger parse
 *   Body: { action: "create", bucket, key, vendor, airport, tail, fee_name, fee_amount, notes }
 *   Returns: { ok, document_id, alert_id }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body.action as string;

  const supa = createServiceClient();

  if (action === "presign") {
    const filename = (body.filename as string) || "invoice.pdf";
    const result = await presignUpload(filename, "manual-alerts");
    return NextResponse.json(result);
  }

  if (action === "create") {
    const bucket = body.bucket as string;
    const key = body.key as string;
    const vendor = (body.vendor as string) || "Unknown";
    const airport = (body.airport as string) || "";
    const tail = (body.tail as string) || "";
    const feeName = (body.fee_name as string) || "Manual Alert";
    const feeAmount = typeof body.fee_amount === "number" ? body.fee_amount : 0;
    const notes = (body.notes as string) || "";

    if (!bucket || !key) {
      return NextResponse.json({ error: "bucket and key required" }, { status: 400 });
    }

    // Create a document record
    const { data: doc, error: docErr } = await supa
      .from("documents")
      .insert({
        source: "manual_upload",
        gcs_bucket: bucket,
        gcs_path: key,
        status: "uploaded",
        original_filename: key.split("/").pop() || "invoice.pdf",
      })
      .select("id")
      .single();

    if (docErr || !doc) {
      return NextResponse.json({ error: docErr?.message || "Failed to create document" }, { status: 500 });
    }

    const documentId = doc.id as string;

    // Create the alert
    const { data: alert, error: alertErr } = await supa
      .from("invoice_alerts")
      .insert({
        document_id: documentId,
        rule_id: null,
        status: "pending",
        slack_status: "pending",
        match_reason: `Manual alert: ${feeName}`,
        match_payload: {
          rule_name: "Manual Alert",
          vendor,
          airport_code: airport,
          tail,
          matched_line_items: [{ description: feeName, total: feeAmount }],
        },
        resolution: "havent_started",
        resolution_note: notes || null,
      })
      .select("id")
      .single();

    if (alertErr || !alert) {
      return NextResponse.json({ error: alertErr?.message || "Failed to create alert" }, { status: 500 });
    }

    // Fire-and-forget: trigger the parser to extract invoice data
    if (PARSER_BASE) {
      const url = `${PARSER_BASE.replace(/\/$/, "")}/jobs/parse_document?document_id=${encodeURIComponent(documentId)}`;
      cloudRunFetch(url, {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(180_000),
      }).catch((e) => console.error("[manual-alert] parse trigger failed:", e));
    }

    return NextResponse.json({ ok: true, document_id: documentId, alert_id: alert.id });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
