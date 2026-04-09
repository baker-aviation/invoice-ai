import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret, requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";

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
  const mailbox = process.env.OUTLOOK_OPS_MAILBOX || process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
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

  // Strategy 1: Fetch emails containing BA-ALERT in subject (legacy outbound had tag in subject)
  // Strategy 2: Also fetch by conversationId for threads where tag is only in body
  const filter1 = `receivedDateTime ge ${since} and contains(subject, 'BA-ALERT')`;
  const graphUrl1 = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(filter1)}&$top=50&$select=id,subject,from,toRecipients,ccRecipients,body,receivedDateTime,conversationId,internetMessageId&$orderby=receivedDateTime asc`;

  // Also fetch by known conversation IDs from our outbound emails
  const { data: convRows } = await supa
    .from("invoice_alert_emails")
    .select("graph_conversation_id, alert_id")
    .eq("direction", "outbound")
    .not("graph_conversation_id", "is", null);
  const convMap = new Map<string, string>();
  for (const row of convRows ?? []) {
    if (row.graph_conversation_id) convMap.set(row.graph_conversation_id as string, row.alert_id as string);
  }

  const [msgRes1, ...convResults] = await Promise.all([
    fetch(graphUrl1, { headers: { Authorization: `Bearer ${token}` } }),
    // Fetch by conversationId in batches (Graph limits filter length)
    ...(convMap.size > 0
      ? [
          fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(
              `receivedDateTime ge ${since} and (${[...convMap.keys()].slice(0, 10).map((c) => `conversationId eq '${c}'`).join(" or ")})`
            )}&$top=50&$select=id,subject,from,toRecipients,ccRecipients,body,receivedDateTime,conversationId,internetMessageId&$orderby=receivedDateTime asc`,
            { headers: { Authorization: `Bearer ${token}` } },
          ),
        ]
      : []),
  ]);

  if (!msgRes1.ok) {
    const errText = await msgRes1.text();
    throw new Error(`Graph fetch failed: ${msgRes1.status} ${errText.slice(0, 200)}`);
  }

  const msgData1 = await msgRes1.json();
  const allMessages = [...(msgData1.value ?? [])];

  // Merge conversation-based results (dedup by id)
  const seenMsgIds = new Set(allMessages.map((m: { id: string }) => m.id));
  for (const convRes of convResults) {
    if (convRes.ok) {
      const convData = await convRes.json();
      for (const msg of convData.value ?? []) {
        if (!seenMsgIds.has(msg.id)) {
          allMessages.push(msg);
          seenMsgIds.add(msg.id);
        }
      }
    }
  }

  const messages = allMessages;

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

    // Try tag in subject first, then body, then conversationId
    const subjectMatch = TAG_RE.exec(msg.subject ?? "");
    const bodyMatch = !subjectMatch ? TAG_RE.exec(msg.body?.content ?? "") : null;
    const match = subjectMatch || bodyMatch;

    let alertId: string | null = null;

    if (match) {
      const shortId = match[1].toLowerCase();
      const { data: alerts } = await supa
        .from("invoice_alerts")
        .select("id")
        .ilike("id", `${shortId}%`)
        .limit(1);
      if (alerts?.length) alertId = alerts[0].id as string;
    }

    // Fallback: match by conversationId from our outbound threads
    if (!alertId && msg.conversationId && convMap.has(msg.conversationId)) {
      alertId = convMap.get(msg.conversationId)!;
    }

    if (!alertId) { skipped++; continue; }

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

    // Notify Slack if alert is assigned
    try {
      const { data: alertRow } = await supa
        .from("invoice_alerts")
        .select("assigned_to, match_payload")
        .eq("id", alertId)
        .single();

      if (alertRow?.assigned_to) {
        const mp = (alertRow.match_payload ?? {}) as Record<string, string>;
        const vendor = mp.vendor || "Unknown FBO";
        const preview = bodyText.slice(0, 150) + (bodyText.length > 150 ? "…" : "");
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://baker-ai-gamma.vercel.app");

        await postSlackMessage({
          channel: process.env.SLACK_INVOICE_ALERTS_CHANNEL || "C0AG6HZ4Q6N",
          text: `Email reply on alert assigned to ${alertRow.assigned_to}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Email reply received* — assigned to *${alertRow.assigned_to}*\n*From:* ${fromAddr}\n*Vendor:* ${vendor}\n\n>${preview.replace(/\n/g, "\n>")}`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "View Alert" },
                  url: `${appUrl}/invoices?tab=alerts`,
                },
              ],
            },
          ],
        });
      }
    } catch (slackErr) {
      console.error("[alert-replies] Slack notification failed:", slackErr);
    }

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
