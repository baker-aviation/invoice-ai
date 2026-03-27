import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenant || !clientId || !clientSecret) {
    throw new Error("MS Graph credentials not configured (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)");
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MS Graph token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// MS Graph inline attachment limit is ~3MB base64 (~2.25MB raw)
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/**
 * POST /api/ops/intl/send-docs-email
 *
 * Send trip documents as email attachments from the handling mailbox.
 * Body: { to: string[], cc?: string[], subject: string, body: string, document_ids: string[] }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Rate limit — max 5 emails per minute" }, { status: 429 });
  }

  let input: { to: string[]; cc?: string[]; subject: string; body: string; document_ids: string[] };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate
  if (!input.to?.length || !input.to.every((a) => a.includes("@"))) {
    return NextResponse.json({ error: "Valid 'to' addresses required" }, { status: 400 });
  }
  if (!input.subject?.trim()) {
    return NextResponse.json({ error: "Subject required" }, { status: 400 });
  }
  if (!input.document_ids?.length) {
    return NextResponse.json({ error: "At least one document required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch document metadata
  const { data: docs, error: docsErr } = await supa
    .from("intl_documents")
    .select("id, name, gcs_bucket, gcs_key, content_type, filename")
    .in("id", input.document_ids)
    .eq("is_current", true);

  if (docsErr || !docs || docs.length === 0) {
    return NextResponse.json({ error: "No valid documents found" }, { status: 400 });
  }

  // Download files from GCS and build Graph attachments
  const storage = await getGcsStorage();
  const attachments: Array<Record<string, string>> = [];
  let totalBytes = 0;

  for (const doc of docs) {
    try {
      const [buffer] = await storage.bucket(doc.gcs_bucket).file(doc.gcs_key).download();
      totalBytes += buffer.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return NextResponse.json({
          error: `Attachments too large (${(totalBytes / 1024 / 1024).toFixed(1)}MB). Max ~3MB. Deselect some documents.`,
        }, { status: 400 });
      }
      attachments.push({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: doc.filename || `${doc.name}.pdf`,
        contentType: doc.content_type || "application/pdf",
        contentBytes: buffer.toString("base64"),
      });
    } catch (err) {
      console.error(`[send-docs-email] Failed to download ${doc.name}:`, err);
      return NextResponse.json({ error: `Failed to fetch document: ${doc.name}` }, { status: 500 });
    }
  }

  // Build HTML body (escape + newline→br)
  const htmlBody = input.body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  // Send via MS Graph
  const mailbox = process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) {
    return NextResponse.json({ error: "No handling mailbox configured" }, { status: 500 });
  }

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    console.error("[send-docs-email] Token error:", err);
    return NextResponse.json({ error: "Failed to authenticate with email service" }, { status: 500 });
  }

  const graphPayload = {
    message: {
      subject: input.subject,
      body: {
        contentType: "HTML",
        content: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">${htmlBody}</div>`,
      },
      toRecipients: input.to.map((addr) => ({ emailAddress: { address: addr } })),
      ccRecipients: (input.cc ?? []).map((addr) => ({ emailAddress: { address: addr } })),
      attachments,
    },
    saveToSentItems: true,
  };

  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(graphPayload),
    },
  );

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    console.error("[send-docs-email] Graph sendMail failed:", sendRes.status, errText);
    return NextResponse.json(
      { error: `Email send failed (HTTP ${sendRes.status})`, detail: errText.slice(0, 300) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    sent_to: input.to,
    cc: input.cc ?? [],
    attachment_count: attachments.length,
  });
}
