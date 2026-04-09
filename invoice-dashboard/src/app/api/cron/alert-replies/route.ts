import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret, requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

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

const TAG_RE = /\[BA-ALERT-([A-F0-9]{8})\]/i;

async function pullReplies(): Promise<{ imported: number; skipped: number; total: number }> {
  const mailbox = process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) throw new Error("No handling mailbox configured");

  const token = await getGraphToken();
  const supa = createServiceClient();

  // Get latest inbound timestamp
  const { data: latest } = await supa
    .from("invoice_alert_emails")
    .select("received_at")
    .eq("direction", "inbound")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const since = latest?.received_at
    ? new Date(latest.received_at as string).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Fetch emails containing BA-ALERT tag
  const filter = `receivedDateTime ge ${since} and contains(subject, 'BA-ALERT')`;
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(filter)}&$top=50&$select=id,subject,from,toRecipients,ccRecipients,body,receivedDateTime,conversationId,internetMessageId&$orderby=receivedDateTime asc`;

  const msgRes = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!msgRes.ok) {
    const errText = await msgRes.text();
    throw new Error(`Graph fetch failed: ${msgRes.status} ${errText.slice(0, 200)}`);
  }

  const msgData = await msgRes.json();
  const messages = msgData.value ?? [];

  // Known message IDs for dedup
  const { data: existing } = await supa
    .from("invoice_alert_emails")
    .select("graph_internet_message_id")
    .not("graph_internet_message_id", "is", null);
  const knownIds = new Set((existing ?? []).map((e) => e.graph_internet_message_id));

  // Our own outbound IDs
  const { data: outbound } = await supa
    .from("invoice_alert_emails")
    .select("graph_message_id, graph_internet_message_id")
    .eq("direction", "outbound");
  const ourMessageIds = new Set((outbound ?? []).map((e) => e.graph_message_id));
  const ourInternetIds = new Set((outbound ?? []).map((e) => e.graph_internet_message_id));

  let imported = 0;
  let skipped = 0;

  for (const msg of messages) {
    if (knownIds.has(msg.internetMessageId)) { skipped++; continue; }
    if (ourMessageIds.has(msg.id) || ourInternetIds.has(msg.internetMessageId)) { skipped++; continue; }

    const match = TAG_RE.exec(msg.subject ?? "");
    if (!match) { skipped++; continue; }

    const shortId = match[1].toLowerCase();
    const { data: alerts } = await supa
      .from("invoice_alerts")
      .select("id")
      .ilike("id", `${shortId}%`)
      .limit(1);

    if (!alerts?.length) { skipped++; continue; }
    const alertId = alerts[0].id as string;

    const fromAddr = msg.from?.emailAddress?.address?.toLowerCase() ?? "";
    if (fromAddr === mailbox.toLowerCase()) { skipped++; continue; }

    const bodyHtml = msg.body?.content ?? "";
    const bodyText = bodyHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 10000);

    const toAddrs = (msg.toRecipients ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean);
    const ccAddrs = (msg.ccRecipients ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean);

    await supa.from("invoice_alert_emails").insert({
      alert_id: alertId,
      direction: "inbound",
      from_address: fromAddr,
      to_addresses: toAddrs,
      cc_addresses: ccAddrs,
      subject: msg.subject ?? "",
      body_html: bodyHtml.slice(0, 50000),
      body_text: bodyText,
      graph_message_id: msg.id,
      graph_conversation_id: msg.conversationId,
      graph_internet_message_id: msg.internetMessageId,
      received_at: msg.receivedDateTime,
    });

    imported++;
  }

  return { imported, skipped, total: messages.length };
}

/** GET — Vercel cron trigger */
export async function GET(req: NextRequest) {
  if (verifyCronSecret(req)) {
    try {
      const result = await pullReplies();
      return NextResponse.json({ ok: true, ...result });
    } catch (err: unknown) {
      console.error("[alert-replies cron] Error:", err);
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const result = await pullReplies();
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    console.error("[alert-replies] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
