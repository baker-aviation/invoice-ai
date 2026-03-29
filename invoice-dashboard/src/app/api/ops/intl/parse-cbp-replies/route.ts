import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

// ---------------------------------------------------------------------------
// MS Graph token (same pattern as send-docs-email)
// ---------------------------------------------------------------------------
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
  if (!res.ok) throw new Error(`Token failed: ${res.status}`);
  return (await res.json()).access_token;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseSubject(subject: string): {
  tail: string | null;
  dateStr: string | null;
  clearanceType: "outbound_clearance" | "inbound_clearance" | null;
} {
  const clean = subject.replace(/^(Re|RE|Fwd|FW):\s*/gi, "").trim();

  // Clearance type
  const isOutbound = /outbound/i.test(clean);
  const isInbound = /landing\s*rights|inbound/i.test(clean);
  const clearanceType = isOutbound
    ? "outbound_clearance"
    : isInbound
    ? "inbound_clearance"
    : null;

  // Tail number: N-prefix + digits + letters, or just digits+letters (prepend N)
  const tailMatch =
    clean.match(/\b(N\d{1,5}[A-Z]{0,2})\b/i) ||
    clean.match(/\b(\d{2,5}[A-Z]{1,2})\b/i);
  let tail = tailMatch ? tailMatch[1].toUpperCase() : null;
  if (tail && !tail.startsWith("N")) tail = "N" + tail;

  // Date: "3/29", "03/29", "29MAR"
  let dateStr: string | null = null;
  const slashMatch = clean.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  const monthNames: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const ddMonMatch = clean.match(/(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i);

  if (slashMatch) {
    const m = slashMatch[1].padStart(2, "0");
    const d = slashMatch[2].padStart(2, "0");
    const y = slashMatch[3] || new Date().getFullYear().toString();
    dateStr = `${y.length === 2 ? "20" + y : y}-${m}-${d}`;
  } else if (ddMonMatch) {
    const d = ddMonMatch[1].padStart(2, "0");
    const m = monthNames[ddMonMatch[2].toUpperCase()];
    dateStr = `${new Date().getFullYear()}-${m}-${d}`;
  }

  return { tail, dateStr, clearanceType };
}

function parseBody(bodyHtml: string): {
  status: "approved" | "denied" | "info";
  logNumber: string | null;
  officer: string | null;
} {
  // Strip HTML and collapse whitespace
  const text = bodyHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract reply portion (before the quoted original)
  const replyPart = text.split(/From: Baker|_{10,}/)[0] || text;

  // Status
  let status: "approved" | "denied" | "info" = "info";
  if (/\b(denied|not\s+approved|rejected)\b/i.test(replyPart)) {
    status = "denied";
  } else if (
    /\b(approved|clearance\s+granted|confirmed|authorized|log\s*#\s*\d)/i.test(replyPart)
  ) {
    status = "approved";
  }

  // Log number
  const logMatch = replyPart.match(/log\s*#?\s*:?\s*(\d{4,6})/i);
  const logNumber = logMatch ? logMatch[1] : null;

  // Officer
  let officer: string | null = null;
  const officerMatch =
    replyPart.match(/(?:officer|by)\s*:?\s+([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]*)?)/i) ||
    replyPart.match(/CBP\s+Officer\s+([A-Z][A-Za-z]+)/i) ||
    replyPart.match(/granted\s+by\s+([A-Z]{1,3})\b/i);
  if (officerMatch) officer = officerMatch[1].trim();

  return { status, logNumber, officer };
}

// ---------------------------------------------------------------------------
// GET — fetch CBP replies for a trip
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  // Vercel cron calls GET with Authorization header — run the parser
  if (verifyCronSecret(req)) {
    return runParser();
  }

  // Normal authenticated GET — fetch replies for a trip
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tripId = req.nextUrl.searchParams.get("trip_id");
  if (!tripId) return NextResponse.json({ replies: [] });

  const supa = createServiceClient();
  const { data } = await supa
    .from("intl_cbp_replies")
    .select("*")
    .eq("trip_id", tripId)
    .order("parsed_at", { ascending: false })
    .limit(20);

  return NextResponse.json({ replies: data ?? [] });
}

// ---------------------------------------------------------------------------
// POST — poll handling mailbox, parse CBP replies, update clearances
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  return runParser();
}

async function runParser() {

  const supa = createServiceClient();
  const mailbox = process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) {
    return NextResponse.json({ error: "No handling mailbox configured" }, { status: 500 });
  }

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    console.error("[parse-cbp-replies] Token error:", err);
    return NextResponse.json({ error: "Graph auth failed" }, { status: 500 });
  }

  // Fetch recent CBP emails (last 48 hours)
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const graphUrl =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages` +
    `?$search="from:cbp.dhs.gov"&$top=50&$select=id,subject,from,receivedDateTime,body,hasAttachments`;

  const msgRes = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!msgRes.ok) {
    const errText = await msgRes.text();
    console.error("[parse-cbp-replies] Graph messages failed:", msgRes.status, errText);
    return NextResponse.json({ error: "Failed to fetch emails" }, { status: 500 });
  }

  const msgData = await msgRes.json();
  const messages: Array<{
    id: string;
    subject: string;
    from: { emailAddress: { address: string; name: string } };
    receivedDateTime: string;
    body: { content: string; contentType: string };
    hasAttachments: boolean;
  }> = (msgData.value ?? []).filter((m: { receivedDateTime: string }) =>
    new Date(m.receivedDateTime) >= new Date(since)
  );

  // Check which message IDs we've already processed
  const messageIds = messages.map((m) => m.id);
  if (messageIds.length === 0) {
    return NextResponse.json({ ok: true, messagesScanned: 0, repliesProcessed: 0 });
  }

  const { data: existingReplies } = await supa
    .from("intl_cbp_replies")
    .select("message_id")
    .in("message_id", messageIds);
  const processedIds = new Set((existingReplies ?? []).map((r) => r.message_id));

  const results: Array<Record<string, unknown>> = [];
  let autoApproved = 0;

  for (const msg of messages) {
    if (processedIds.has(msg.id)) continue;

    const { tail, dateStr, clearanceType } = parseSubject(msg.subject);
    const { status, logNumber, officer } = parseBody(msg.body.content);

    // Match to trip
    let tripId: string | null = null;
    let clearanceId: string | null = null;
    let matchConfidence: "high" | "low" | "unmatched" = "unmatched";

    if (tail && dateStr) {
      // Find trip by tail + date (±1 day)
      const dateBefore = new Date(new Date(dateStr + "T00:00:00Z").getTime() - 86400000)
        .toISOString()
        .slice(0, 10);
      const dateAfter = new Date(new Date(dateStr + "T00:00:00Z").getTime() + 86400000)
        .toISOString()
        .slice(0, 10);

      const { data: trips } = await supa
        .from("intl_trips")
        .select("id, trip_date")
        .eq("tail_number", tail)
        .gte("trip_date", dateBefore)
        .lte("trip_date", dateAfter);

      if (trips && trips.length > 0) {
        // Prefer exact date match
        const exact = trips.find((t) => t.trip_date === dateStr);
        tripId = exact?.id ?? trips[0].id;
        matchConfidence = exact ? "high" : "low";
      }
    } else if (tail) {
      // Try tail only (recent trips)
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const { data: trips } = await supa
        .from("intl_trips")
        .select("id")
        .eq("tail_number", tail)
        .gte("trip_date", weekAgo)
        .order("trip_date", { ascending: false })
        .limit(1);
      if (trips?.[0]) {
        tripId = trips[0].id;
        matchConfidence = "low";
      }
    }

    // Extract airport ICAO from the from address (e.g. KMIA_GAP@cbp.dhs.gov → KMIA)
    const fromIcaoMatch = msg.from.emailAddress.address.match(/^(K[A-Z]{2,3})[-_]/i);
    const fromIcao = fromIcaoMatch ? fromIcaoMatch[1].toUpperCase() : null;

    // Match to clearance using multiple signals:
    // 1. clearanceType from subject ("Outbound" / "Landing Rights")
    // 2. fromIcao from email address (matches clearance airport_icao)
    if (tripId) {
      const { data: clearances } = await supa
        .from("intl_trip_clearances")
        .select("id, status, clearance_type, airport_icao")
        .eq("trip_id", tripId);

      if (clearances && clearances.length > 0) {
        let candidates = clearances;

        // Filter by clearance type from subject if we have it
        if (clearanceType) {
          const typed = candidates.filter((c) => c.clearance_type === clearanceType);
          if (typed.length > 0) candidates = typed;
        }

        // Filter by airport ICAO from the from address
        if (fromIcao) {
          const byAirport = candidates.filter((c) => c.airport_icao === fromIcao);
          if (byAirport.length > 0) {
            candidates = byAirport;
            if (matchConfidence === "unmatched") matchConfidence = "low";
          }
        }

        // Prefer non-approved clearance (the one waiting for CBP response)
        const pending = candidates.find((c) => c.status !== "approved");
        clearanceId = pending?.id ?? candidates[0]?.id ?? null;
      }
    }

    // Download attachments if any
    const attachments: Array<{ name: string; gcs_key: string; gcs_bucket: string; content_type: string }> = [];
    if (msg.hasAttachments) {
      try {
        const attRes = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${msg.id}/attachments`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (attRes.ok) {
          const attData = await attRes.json();
          const storage = await getGcsStorage();
          const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";

          for (const att of attData.value ?? []) {
            // Skip inline images (CID attachments)
            if (att.isInline || !att.contentBytes) continue;

            const safeName = (att.name || "attachment").replace(/\//g, "_");
            const gcsKey = `intl/cbp-replies/${Date.now()}-${safeName}`;

            try {
              const buf = Buffer.from(att.contentBytes, "base64");
              await storage.bucket(bucket).file(gcsKey).save(buf, {
                contentType: att.contentType || "application/octet-stream",
              });
              attachments.push({
                name: att.name || "attachment",
                gcs_key: gcsKey,
                gcs_bucket: bucket,
                content_type: att.contentType || "application/octet-stream",
              });
            } catch (e) {
              console.error(`[parse-cbp-replies] Failed to save attachment ${safeName}:`, e);
            }
          }
        }
      } catch (e) {
        console.error("[parse-cbp-replies] Failed to fetch attachments:", e);
      }
    }

    // Insert reply record
    const { error: insertErr } = await supa.from("intl_cbp_replies").insert({
      message_id: msg.id,
      trip_id: tripId,
      clearance_id: clearanceId,
      from_address: msg.from.emailAddress.address,
      subject: msg.subject,
      status,
      log_number: logNumber,
      officer,
      raw_body: msg.body.content.substring(0, 10000),
      match_confidence: matchConfidence,
      attachments: attachments.length > 0 ? attachments : [],
    });

    if (insertErr) {
      console.error("[parse-cbp-replies] Insert error:", insertErr);
      continue;
    }

    // Auto-update clearance if approved
    let autoUpdated = false;
    if (status === "approved" && clearanceId) {
      const notesParts = ["CBP Approved"];
      if (logNumber) notesParts.push(`Log# ${logNumber}`);
      if (officer) notesParts.push(`Officer: ${officer}`);
      notesParts.push(`(auto-parsed ${new Date().toISOString().slice(0, 16)}Z)`);

      await supa
        .from("intl_trip_clearances")
        .update({ status: "approved", notes: notesParts.join(" — ") })
        .eq("id", clearanceId);
      autoUpdated = true;
      autoApproved++;
    }

    results.push({
      messageId: msg.id,
      subject: msg.subject,
      from: msg.from.emailAddress.address,
      status,
      logNumber,
      officer,
      tripId,
      clearanceId,
      matchConfidence,
      autoUpdated,
      attachments: attachments.length,
    });
  }

  return NextResponse.json({
    ok: true,
    messagesScanned: messages.length,
    repliesProcessed: results.length,
    repliesSkipped: messages.length - results.length,
    autoApproved,
    results,
  });
}
