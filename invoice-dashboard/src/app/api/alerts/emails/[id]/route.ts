import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("MS Graph credentials not configured");
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

/** GET — list email thread for an alert */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid alert ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("invoice_alert_emails")
    .select("id, alert_id, direction, from_address, to_addresses, cc_addresses, subject, body_html, body_text, sent_by, received_at, created_at")
    .eq("alert_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, emails: data ?? [] });
}

/**
 * POST — send an outbound email from handling@baker-aviation.com
 * Tagged with [BA-ALERT-{short_id}] for reply matching.
 *
 * Body: { to: string[], cc?: string[], body: string, include_pdf?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Rate limit — max 5 emails per minute" }, { status: 429 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid alert ID" }, { status: 400 });
  }

  const input = await req.json().catch(() => ({} as Record<string, unknown>));
  const to = input.to as string[];
  const cc = (input.cc as string[]) ?? [];
  const bodyText = typeof input.body === "string" ? input.body.trim() : "";
  const includePdf = input.include_pdf === true;

  if (!to?.length || !to.every((a: string) => a.includes("@"))) {
    return NextResponse.json({ error: "Valid 'to' addresses required" }, { status: 400 });
  }
  if (!bodyText) {
    return NextResponse.json({ error: "Email body required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch alert details for the subject line
  const { data: alert, error: alertErr } = await supa
    .from("invoice_alerts")
    .select("id, match_payload, document_id")
    .eq("id", id)
    .single();

  if (alertErr || !alert) {
    return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }

  const mp = (alert.match_payload ?? {}) as Record<string, unknown>;
  let vendor = (mp.vendor as string) || "";
  let airport = (mp.airport_code as string) || "";
  let tail = (mp.tail as string) || "";
  const feeName = ((mp.matched_line_items as Array<Record<string, unknown>>)?.[0]?.description as string) || "Fee Alert";

  // Fallback to parsed_invoices for vendor/airport/tail if match_payload is sparse
  if (!vendor || !airport || !tail) {
    const { data: inv } = await supa
      .from("parsed_invoices")
      .select("vendor_name, airport_code, tail_number")
      .eq("document_id", alert.document_id)
      .limit(1)
      .maybeSingle();
    if (inv) {
      if (!vendor) vendor = (inv.vendor_name as string) || "";
      if (!airport) airport = (inv.airport_code as string) || "";
      if (!tail) tail = (inv.tail_number as string) || "";
    }
  }
  if (!vendor) vendor = "Unknown FBO";

  // Short ID for tag (first 8 chars of UUID)
  const shortId = id.slice(0, 8).toUpperCase();
  const tag = `[BA-ALERT-${shortId}]`;
  const subject = `${tag} ${feeName} — ${vendor}${airport ? ` | ${airport}` : ""}${tail ? ` | ${tail}` : ""}`;

  // Build HTML
  const htmlBody = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  // Optionally attach the invoice PDF from GCS
  const attachments: Array<Record<string, string>> = [];
  if (includePdf && alert.document_id) {
    const { data: doc } = await supa
      .from("documents")
      .select("id, gcs_bucket, gcs_path")
      .eq("id", alert.document_id)
      .single();

    if (doc?.gcs_bucket && doc?.gcs_path) {
      try {
        const storage = getGcsStorage();
        const [buffer] = await storage.bucket(doc.gcs_bucket as string).file(doc.gcs_path as string).download();
        const filename = (doc.gcs_path as string).split("/").pop() || "invoice.pdf";
        attachments.push({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: filename,
          contentType: "application/pdf",
          contentBytes: buffer.toString("base64"),
        });
      } catch (err) {
        console.error("[alert-email] PDF download failed:", err);
        // Continue without attachment rather than failing the whole email
      }
    }
  }

  const mailbox = process.env.OUTLOOK_OPS_MAILBOX || process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) {
    return NextResponse.json({ error: "No handling mailbox configured" }, { status: 500 });
  }

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    console.error("[alert-email] Token error:", err);
    return NextResponse.json({ error: "Failed to authenticate with email service" }, { status: 500 });
  }

  // Check for existing conversation thread (reply to last outbound)
  const { data: lastEmail } = await supa
    .from("invoice_alert_emails")
    .select("graph_conversation_id, graph_internet_message_id, subject")
    .eq("alert_id", id)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const isReply = !!lastEmail?.graph_conversation_id;

  const messagePayload: Record<string, unknown> = {
    subject: isReply ? `Re: ${lastEmail.subject}` : subject,
    body: {
      contentType: "HTML",
      content: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">${htmlBody}<br><br><span style="color:#999;font-size:11px;">Ref: ${tag}</span></div>`,
    },
    toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
    ccRecipients: cc.map((addr) => ({ emailAddress: { address: addr } })),
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  // If replying to existing thread, set conversationId
  if (isReply && lastEmail.graph_conversation_id) {
    messagePayload.conversationId = lastEmail.graph_conversation_id;
  }

  // Use sendMail (only requires Mail.Send, not Mail.ReadWrite)
  const finalSubject = isReply ? `Re: ${lastEmail!.subject}` : subject;
  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: messagePayload,
        saveToSentItems: true,
      }),
    },
  );

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    console.error("[alert-email] Graph sendMail failed:", sendRes.status, errText);
    return NextResponse.json({ error: `Email send failed (HTTP ${sendRes.status})`, detail: errText.slice(0, 500), mailbox }, { status: 500 });
  }

  // Store in invoice_alert_emails
  await supa.from("invoice_alert_emails").insert({
    alert_id: id,
    direction: "outbound",
    from_address: mailbox,
    to_addresses: to,
    cc_addresses: cc,
    subject: finalSubject,
    body_html: htmlBody,
    body_text: bodyText,
    sent_by: auth.email ?? auth.userId,
  });

  return NextResponse.json({ ok: true, sent_to: to, subject: finalSubject });
}
