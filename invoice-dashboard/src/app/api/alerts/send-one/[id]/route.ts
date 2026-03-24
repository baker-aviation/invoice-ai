import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtAmount(amount: number | null, currency: string): string {
  if (amount == null || amount <= 0) return "—";
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`.trim();
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (!SLACK_WEBHOOK_URL) {
    return NextResponse.json({ error: "Slack webhook not configured" }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid alert ID" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch alert
  const { data: alert, error: alertErr } = await supa
    .from("invoice_alerts")
    .select("id, document_id, rule_id, status, slack_status, match_payload")
    .eq("id", id)
    .single();

  if (alertErr || !alert) {
    return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }

  const documentId = alert.document_id;
  if (!documentId) {
    return NextResponse.json({ error: "Alert has no document_id" }, { status: 400 });
  }

  // Fetch parsed invoice for vendor/airport/tail
  const { data: invoice } = await supa
    .from("parsed_invoices")
    .select("vendor_name, airport_code, tail_number, currency")
    .eq("document_id", documentId)
    .single();

  // Fetch document for PDF URL
  const { data: doc } = await supa
    .from("documents")
    .select("id, gcs_bucket, gcs_path")
    .eq("id", documentId)
    .single();

  // Extract fee details from match_payload
  const mp = typeof alert.match_payload === "string"
    ? JSON.parse(alert.match_payload)
    : (alert.match_payload ?? {});

  const matchedItems = Array.isArray(mp.matched_line_items) ? mp.matched_line_items : [];
  const firstItem = matchedItems[0] ?? {};

  const feeName = (firstItem.description ?? mp.fee_name ?? mp.rule_name ?? "Fee").trim();
  const feeAmount = parseFloat(firstItem.total ?? firstItem.amount ?? mp.fee_amount ?? "0");
  const ruleName = mp.rule_name ?? "Fee Alert";

  if (!feeName || isNaN(feeAmount) || feeAmount <= 0) {
    return NextResponse.json({ error: "Non-actionable alert (missing fee)" }, { status: 400 });
  }

  const fbo = invoice?.vendor_name ?? "—";
  const airportCode = invoice?.airport_code ?? mp.airport_code ?? "—";
  const tail = invoice?.tail_number ?? mp.tail ?? "—";
  const currency = invoice?.currency ?? mp.currency ?? "USD";

  // Sign PDF URL
  let pdfLine = "—";
  if (doc?.gcs_bucket && doc?.gcs_path) {
    const signedUrl = await signGcsUrl(doc.gcs_bucket, doc.gcs_path);
    if (signedUrl) pdfLine = `<${signedUrl}|Open PDF>`;
  }

  // Build Slack payload (matches backend format)
  const topLine = `🚨 ${feeName} | ${fbo} | ${airportCode} | ${tail}`;
  const slackPayload = {
    text: topLine,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🚨 Fee Alert" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*FBO:*\n${fbo}` },
          { type: "mrkdwn", text: `*Airport Code:*\n${airportCode}` },
          { type: "mrkdwn", text: `*Tail:*\n${tail}` },
          { type: "mrkdwn", text: `*Fee name:*\n${feeName}` },
          { type: "mrkdwn", text: `*Fee amount:*\n${fmtAmount(feeAmount, currency)}` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*PDF:*\n${pdfLine}` } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Rule: \`${ruleName}\`  •  document_id: \`${documentId}\`` }],
      },
    ],
  };

  // Post to Slack
  try {
    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    });

    if (slackRes.ok) {
      // Update alert status
      await supa
        .from("invoice_alerts")
        .update({ slack_status: "sent", slack_error: null })
        .eq("id", id);

      return NextResponse.json({ ok: true, sent: true, alert_id: id });
    } else {
      const errText = await slackRes.text().catch(() => "");
      await supa
        .from("invoice_alerts")
        .update({ slack_status: "error", slack_error: errText.slice(0, 1000) })
        .eq("id", id);

      return NextResponse.json({ error: "Slack delivery failed" }, { status: 502 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Slack request failed" }, { status: 502 });
  }
}
