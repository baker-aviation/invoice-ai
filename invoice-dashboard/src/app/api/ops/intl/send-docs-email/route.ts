import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

/**
 * GET /api/ops/intl/send-docs-email?trip_id=xxx
 * Returns email send history for a trip.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tripId = req.nextUrl.searchParams.get("trip_id");
  if (!tripId) return NextResponse.json({ emails: [] });

  const supa = createServiceClient();
  const { data } = await supa
    .from("intl_doc_emails")
    .select("id, sent_to, sent_cc, subject, document_count, sent_by_name, sent_at")
    .eq("trip_id", tripId)
    .order("sent_at", { ascending: false })
    .limit(10);

  return NextResponse.json({ emails: data ?? [] });
}

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

  let input: { to: string[]; cc?: string[]; subject: string; body: string; document_ids: string[]; trip_id?: string };
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

  const messagePayload = {
    subject: input.subject,
    body: {
      contentType: "HTML",
      content: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">${htmlBody}</div>`,
    },
    toRecipients: input.to.map((addr) => ({ emailAddress: { address: addr } })),
    ccRecipients: (input.cc ?? []).map((addr) => ({ emailAddress: { address: addr } })),
    attachments,
  };

  // Step 1: Create draft message (gives us conversationId for thread matching)
  const createRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(messagePayload),
    },
  );

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error("[send-docs-email] Graph create draft failed:", createRes.status, errText);
    return NextResponse.json(
      { error: `Email draft failed (HTTP ${createRes.status})`, detail: errText.slice(0, 300) },
      { status: 500 },
    );
  }

  const draft = await createRes.json();
  const graphMessageId = draft.id;
  const conversationId = draft.conversationId;
  const internetMessageId = draft.internetMessageId;

  // Step 2: Send the draft
  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${graphMessageId}/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    console.error("[send-docs-email] Graph send failed:", sendRes.status, errText);
    // Clean up draft
    await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${graphMessageId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => {});
    return NextResponse.json(
      { error: `Email send failed (HTTP ${sendRes.status})`, detail: errText.slice(0, 300) },
      { status: 500 },
    );
  }

  // Log the send to intl_doc_emails with conversation thread IDs
  if (input.trip_id) {
    const { data: profile } = await supa
      .from("profiles")
      .select("full_name")
      .eq("id", auth.userId)
      .single();

    await supa.from("intl_doc_emails").insert({
      trip_id: input.trip_id,
      sent_to: input.to,
      sent_cc: input.cc ?? [],
      subject: input.subject,
      document_count: attachments.length,
      sent_by: auth.userId,
      sent_by_name: profile?.full_name ?? null,
      conversation_id: conversationId,
      internet_message_id: internetMessageId,
      graph_message_id: graphMessageId,
    });
  }

  return NextResponse.json({
    ok: true,
    sent_to: input.to,
    cc: input.cc ?? [],
    attachment_count: attachments.length,
  });
}
