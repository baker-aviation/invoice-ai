import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

/**
 * POST /api/ops/intl/send-pinnacle-request
 *
 * Send a Pinnacle overflight permit request email (Cuba/Nicaragua).
 * Body: { subject: string, body: string, trip_id?: string }
 */

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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MS Graph token failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Rate limit — max 5 emails per minute" }, { status: 429 });
  }

  let input: { subject: string; body: string; trip_id?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!input.subject?.trim() || !input.body?.trim()) {
    return NextResponse.json({ error: "Subject and body required" }, { status: 400 });
  }

  const mailbox = process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) {
    return NextResponse.json({ error: "No handling mailbox configured" }, { status: 500 });
  }

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    console.error("[send-pinnacle-request] Token error:", err);
    return NextResponse.json({ error: "Failed to authenticate with email service" }, { status: 500 });
  }

  const htmlBody = input.body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const messagePayload = {
    subject: input.subject,
    body: {
      contentType: "HTML",
      content: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">${htmlBody}</div>`,
    },
    toRecipients: [{ emailAddress: { address: "ops@pinnacle-ops.com" } }],
    ccRecipients: [],
  };

  // Create draft
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
    console.error("[send-pinnacle-request] Draft failed:", createRes.status, errText);
    return NextResponse.json(
      { error: `Email draft failed (HTTP ${createRes.status})` },
      { status: 500 },
    );
  }

  const draft = await createRes.json();

  // Send the draft
  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${draft.id}/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    console.error("[send-pinnacle-request] Send failed:", sendRes.status, errText);
    // Clean up draft
    await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${draft.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => {});
    return NextResponse.json(
      { error: `Email send failed (HTTP ${sendRes.status})` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    sent_to: "ops@pinnacle-ops.com",
    subject: input.subject,
  });
}
