import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

// ---------------------------------------------------------------------------
// MS Graph token
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

const MONTH_MAP: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function extractTailAndDate(subject: string): { tail: string | null; dateStr: string | null } {
  const clean = subject.replace(/^(Re|RE|Fwd|FW):\s*/gi, "").trim();

  // Tail number
  const tailMatch =
    clean.match(/\b(N\d{1,5}[A-Z]{0,2})\b/i) ||
    clean.match(/\b(\d{2,5}[A-Z]{1,2})\b/i);
  let tail = tailMatch ? tailMatch[1].toUpperCase() : null;
  if (tail && !tail.startsWith("N")) tail = "N" + tail;

  // Date: "3/29", "03/29", "29MAR", "29Mar"
  let dateStr: string | null = null;
  const slashMatch = clean.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  const ddMonMatch = clean.match(/(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i);
  const monDdMatch = clean.match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\w*\s+(\d{1,2})/i);

  if (slashMatch) {
    const m = slashMatch[1].padStart(2, "0");
    const d = slashMatch[2].padStart(2, "0");
    const y = slashMatch[3] || new Date().getFullYear().toString();
    dateStr = `${y.length === 2 ? "20" + y : y}-${m}-${d}`;
  } else if (ddMonMatch) {
    const d = ddMonMatch[1].padStart(2, "0");
    const m = MONTH_MAP[ddMonMatch[2].toUpperCase()];
    dateStr = `${new Date().getFullYear()}-${m}-${d}`;
  } else if (monDdMatch) {
    const m = MONTH_MAP[monDdMatch[1].toUpperCase()];
    const d = monDdMatch[2].padStart(2, "0");
    dateStr = `${new Date().getFullYear()}-${m}-${d}`;
  }

  return { tail, dateStr };
}

function parseCbpBody(bodyHtml: string): {
  status: "approved" | "denied" | "info";
  logNumber: string | null;
  officer: string | null;
} {
  const text = bodyHtml.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  const replyPart = text.split(/From: Baker|_{10,}/)[0] || text;

  let status: "approved" | "denied" | "info" = "info";
  if (/\b(denied|not\s+approved|rejected)\b/i.test(replyPart)) {
    status = "denied";
  } else if (/\b(approved|clearance\s+granted|confirmed|authorized|log\s*#\s*\d)/i.test(replyPart)) {
    status = "approved";
  }

  const logMatch = replyPart.match(/log\s*#?\s*:?\s*(\d{4,6})/i);
  const logNumber = logMatch ? logMatch[1] : null;

  let officer: string | null = null;
  const officerMatch =
    replyPart.match(/(?:officer|by)\s*:?\s+([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]*)?)/i) ||
    replyPart.match(/CBP\s+Officer\s+([A-Z][A-Za-z]+)/i) ||
    replyPart.match(/granted\s+by\s+([A-Z]{1,3})\b/i);
  if (officerMatch) officer = officerMatch[1].trim();

  return { status, logNumber, officer };
}

function parseHandlerBody(bodyHtml: string): {
  status: "confirmed" | "needs_info" | "info";
  note: string;
} {
  const text = bodyHtml.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  const replyPart = text.split(/From: Baker|_{10,}/)[0] || text;

  // Action items the handler is requesting
  if (/\b(please\s+(?:provide|send)|kindly\s+provide)\s+.{0,30}(gendec|eapis|outbound|itinerary|passport)/i.test(replyPart)) {
    const match = replyPart.match(/(?:please\s+(?:provide|send)|kindly\s+provide)\s+(.{0,60}?)(?:\.|$)/i);
    return { status: "needs_info", note: match ? match[0].trim().substring(0, 100) : "Handler needs info" };
  }

  // Confirmations
  if (/\b(confirmed|well\s+received|received|approved|handling\s+confirmed|services\s+confirmed|clearance\s+granted)\b/i.test(replyPart)) {
    return { status: "confirmed", note: "Handler confirmed" };
  }

  return { status: "info", note: "Handler reply" };
}

// ---------------------------------------------------------------------------
// Email category detection
// ---------------------------------------------------------------------------
type EmailCategory = "cbp" | "pinnacle" | "handler" | "skip";

function categorizeEmail(from: string, subject: string): EmailCategory {
  const addr = from.toLowerCase();
  if (addr.includes("cbp.dhs.gov")) return "cbp";
  if (addr.includes("pinnacle-ops.com")) return "pinnacle";

  // Known handler/FBO domains
  const handlerDomains = [
    "atlanticaviation.com", "jetaviation.com", "signatureaviation.com",
    "signatureflight.co", "bohlke.com", "avservcostarica.com",
    "realalfafly.com", "sa-stt.com", "airninetwo.com",
    "xjet.com", "flyexclusive.com", "rossaviation.com",
    "banyanair.com", "sheltairaviation.com", "millionair.com",
  ];
  if (handlerDomains.some((d) => addr.includes(d))) return "handler";

  // FBO-like addresses (ops@, fbo@, frontdesk@, handling@ at non-baker domains)
  if (!addr.includes("baker-aviation") && /^(ops|fbo|frontdesk|handling|csr|dispatch)\b/i.test(addr)) return "handler";

  return "skip";
}

// ---------------------------------------------------------------------------
// Shared: find trip by tail + date
// ---------------------------------------------------------------------------
async function findTrip(
  supa: ReturnType<typeof createServiceClient>,
  tail: string | null,
  dateStr: string | null,
): Promise<{ tripId: string | null; confidence: "high" | "low" | "unmatched" }> {
  if (tail && dateStr) {
    const dateBefore = new Date(new Date(dateStr + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
    const dateAfter = new Date(new Date(dateStr + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
    const { data: trips } = await supa
      .from("intl_trips")
      .select("id, trip_date")
      .eq("tail_number", tail)
      .gte("trip_date", dateBefore)
      .lte("trip_date", dateAfter);
    if (trips && trips.length > 0) {
      const exact = trips.find((t) => t.trip_date === dateStr);
      return { tripId: exact?.id ?? trips[0].id, confidence: exact ? "high" : "low" };
    }
  }
  if (tail) {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const { data: trips } = await supa
      .from("intl_trips")
      .select("id")
      .eq("tail_number", tail)
      .gte("trip_date", weekAgo)
      .order("trip_date", { ascending: false })
      .limit(1);
    if (trips?.[0]) return { tripId: trips[0].id, confidence: "low" };
  }
  return { tripId: null, confidence: "unmatched" };
}

// ---------------------------------------------------------------------------
// Shared: download non-inline attachments to GCS
// ---------------------------------------------------------------------------
type GcsAttachment = { name: string; gcs_key: string; gcs_bucket: string; content_type: string };

async function downloadAttachments(
  token: string,
  mailbox: string,
  msgId: string,
  gcsPrefix: string,
): Promise<GcsAttachment[]> {
  const attachments: GcsAttachment[] = [];
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${msgId}/attachments`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const storage = await getGcsStorage();
    const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";

    for (const att of data.value ?? []) {
      if (att.isInline || !att.contentBytes) continue;
      const safeName = (att.name || "attachment").replace(/\//g, "_");
      const gcsKey = `${gcsPrefix}/${Date.now()}-${safeName}`;
      try {
        const buf = Buffer.from(att.contentBytes, "base64");
        await storage.bucket(bucket).file(gcsKey).save(buf, {
          contentType: att.contentType || "application/octet-stream",
        });
        attachments.push({ name: att.name || "attachment", gcs_key: gcsKey, gcs_bucket: bucket, content_type: att.contentType || "application/octet-stream" });
      } catch (e) {
        console.error(`[parse-handling] Failed to save attachment ${safeName}:`, e);
      }
    }
  } catch (e) {
    console.error("[parse-handling] Failed to fetch attachments:", e);
  }
  return attachments;
}

// ---------------------------------------------------------------------------
// GET — cron or fetch replies for a trip
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  if (verifyCronSecret(req)) return runParser(48);

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
// POST — manual trigger from dashboard
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // Reprocess attachments mode: re-check rows with empty attachments
  if (req.nextUrl.searchParams.get("reprocess_attachments") === "true") {
    return reprocessAttachments();
  }

  // Allow custom lookback for backfill (e.g. ?lookback=30d)
  const lookbackParam = req.nextUrl.searchParams.get("lookback");
  let lookbackHours = 48;
  if (lookbackParam) {
    const match = lookbackParam.match(/^(\d+)([dhm])$/);
    if (match) {
      const val = parseInt(match[1]);
      lookbackHours = match[2] === "d" ? val * 24 : match[2] === "h" ? val : val / 60;
    }
  }

  return runParser(lookbackHours);
}

// ---------------------------------------------------------------------------
// Reprocess: download attachments for previously parsed rows that have none
// ---------------------------------------------------------------------------
async function reprocessAttachments() {
  const supa = createServiceClient();
  const mailbox = process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) return NextResponse.json({ error: "No mailbox" }, { status: 500 });

  let token: string;
  try { token = await getGraphToken(); } catch {
    return NextResponse.json({ error: "Graph auth failed" }, { status: 500 });
  }

  // Get rows with empty attachments from CBP or Pinnacle
  const { data: rows } = await supa
    .from("intl_cbp_replies")
    .select("id, message_id, from_address, trip_id, subject")
    .or("attachments.is.null,attachments.eq.[]")
    .order("parsed_at", { ascending: false });

  const targets = (rows ?? []).filter((r) => {
    const a = r.from_address.toLowerCase();
    return a.includes("cbp.dhs.gov") || a.includes("pinnacle-ops.com");
  });

  let downloaded = 0;
  let attached = 0;
  let noAttachments = 0;
  let errors = 0;

  for (const row of targets) {
    try {
      const atts = await downloadAttachments(token, mailbox, row.message_id,
        row.from_address.toLowerCase().includes("pinnacle") ? "intl/permits" : "intl/cbp-replies");

      if (atts.length === 0) { noAttachments++; continue; }

      // Update the reply row
      await supa.from("intl_cbp_replies").update({ attachments: atts }).eq("id", row.id);
      downloaded += atts.length;

      // For Pinnacle permits: attach first PDF to a clearance
      if (row.from_address.toLowerCase().includes("pinnacle") && /permit\s*confirm/i.test(row.subject) && row.trip_id) {
        const pdfAtt = atts.find((a) => a.content_type === "application/pdf") ?? atts[0];
        const { data: clearances } = await supa
          .from("intl_trip_clearances")
          .select("id, file_gcs_key")
          .eq("trip_id", row.trip_id)
          .in("clearance_type", ["overflight_permit", "landing_permit"]);

        const noFile = (clearances ?? []).filter((c) => !c.file_gcs_key);
        const target = noFile[0] ?? clearances?.[0];
        if (target) {
          await supa.from("intl_trip_clearances").update({
            file_gcs_bucket: pdfAtt.gcs_bucket,
            file_gcs_key: pdfAtt.gcs_key,
            file_filename: pdfAtt.name,
            file_content_type: pdfAtt.content_type,
          }).eq("id", target.id);
          attached++;
        }
      }
    } catch {
      errors++;
    }
  }

  return NextResponse.json({
    ok: true,
    rowsChecked: targets.length,
    attachmentsDownloaded: downloaded,
    permitsAttachedToClearances: attached,
    noAttachments,
    errors,
  });
}

// ---------------------------------------------------------------------------
// Main parser: CBP + Pinnacle + Handler emails
// ---------------------------------------------------------------------------
async function runParser(lookbackHours = 48) {
  const supa = createServiceClient();
  const mailbox = process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) {
    return NextResponse.json({ error: "No handling mailbox configured" }, { status: 500 });
  }

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    console.error("[parse-handling] Token error:", err);
    return NextResponse.json({ error: "Graph auth failed" }, { status: 500 });
  }

  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const pageSize = lookbackHours > 72 ? 250 : 100;
  const graphUrl =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages` +
    `?$top=${pageSize}&$select=id,subject,from,receivedDateTime,body,hasAttachments&$orderby=receivedDateTime desc` +
    `&$filter=receivedDateTime ge ${since}`;

  const msgRes = await fetch(graphUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!msgRes.ok) {
    const errText = await msgRes.text();
    console.error("[parse-handling] Graph messages failed:", msgRes.status, errText);
    return NextResponse.json({ error: "Failed to fetch emails" }, { status: 500 });
  }

  const msgData = await msgRes.json();
  type GraphMessage = {
    id: string;
    subject: string;
    from: { emailAddress: { address: string; name: string } };
    receivedDateTime: string;
    body: { content: string; contentType: string };
    hasAttachments: boolean;
  };
  const allMessages: GraphMessage[] = msgData.value ?? [];

  // Check which we've already processed
  const messageIds = allMessages.map((m) => m.id);
  if (messageIds.length === 0) {
    return NextResponse.json({ ok: true, messagesScanned: 0, cbp: 0, pinnacle: 0, handler: 0 });
  }

  const { data: existingReplies } = await supa
    .from("intl_cbp_replies")
    .select("message_id")
    .in("message_id", messageIds);
  const processedIds = new Set((existingReplies ?? []).map((r) => r.message_id));

  const stats = { cbp: 0, pinnacle: 0, handler: 0, skipped: 0, autoApproved: 0, permitsAttached: 0 };
  const results: Array<Record<string, unknown>> = [];

  for (const msg of allMessages) {
    if (processedIds.has(msg.id)) continue;

    const fromAddr = msg.from.emailAddress.address;
    const category = categorizeEmail(fromAddr, msg.subject);
    if (category === "skip") continue;

    const { tail, dateStr } = extractTailAndDate(msg.subject);
    const { tripId, confidence } = await findTrip(supa, tail, dateStr);
    let clearanceId: string | null = null;
    let matchConfidence = confidence;

    // ── CBP emails ───────────────────────────────────────────────────
    if (category === "cbp") {
      const clean = msg.subject.replace(/^(Re|RE|Fwd|FW):\s*/gi, "").trim();
      const isOutbound = /outbound/i.test(clean);
      const isInbound = /landing\s*rights|inbound/i.test(clean);
      const clearanceType = isOutbound ? "outbound_clearance" : isInbound ? "inbound_clearance" : null;

      const fromIcaoMatch = fromAddr.match(/^(K[A-Z]{2,3})[-_]/i);
      const fromIcao = fromIcaoMatch ? fromIcaoMatch[1].toUpperCase() : null;

      const { status, logNumber, officer } = parseCbpBody(msg.body.content);

      // Find clearance
      if (tripId) {
        const { data: clearances } = await supa
          .from("intl_trip_clearances")
          .select("id, status, clearance_type, airport_icao")
          .eq("trip_id", tripId);

        if (clearances && clearances.length > 0) {
          let candidates = clearances;

          // Filter by clearance type from subject
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
            } else {
              // Airport in email doesn't match any clearance on this trip — don't guess
              candidates = [];
            }
          }

          if (candidates.length > 0) {
            const pending = candidates.find((c) => c.status !== "approved");
            clearanceId = pending?.id ?? candidates[0]?.id ?? null;
          }
        }
      }

      // Download attachments
      const attachments = msg.hasAttachments ? await downloadAttachments(token, mailbox, msg.id, "intl/cbp-replies") : [];

      // Insert reply record
      await supa.from("intl_cbp_replies").insert({
        message_id: msg.id, trip_id: tripId, clearance_id: clearanceId,
        from_address: fromAddr, subject: msg.subject, status,
        log_number: logNumber, officer,
        raw_body: msg.body.content.substring(0, 10000),
        match_confidence: matchConfidence,
        attachments: attachments.length > 0 ? attachments : [],
      });

      // Auto-approve
      if (status === "approved" && clearanceId) {
        const notesParts = ["CBP Approved"];
        if (logNumber) notesParts.push(`Log# ${logNumber}`);
        if (officer) notesParts.push(`Officer: ${officer}`);
        notesParts.push(`(auto-parsed ${new Date().toISOString().slice(0, 16)}Z)`);
        await supa.from("intl_trip_clearances").update({ status: "approved", notes: notesParts.join(" — ") }).eq("id", clearanceId);
        stats.autoApproved++;
      }

      stats.cbp++;
      results.push({ category: "cbp", subject: msg.subject, status, tripId, clearanceId, matchConfidence, logNumber });
    }

    // ── Pinnacle permit confirmations ────────────────────────────────
    else if (category === "pinnacle") {
      const isPerm = /permit\s*confirm/i.test(msg.subject);

      // Download permit PDF attachments
      const attachments = msg.hasAttachments ? await downloadAttachments(token, mailbox, msg.id, "intl/permits") : [];

      // Attach first PDF to the matching overflight/landing clearance
      let attachedTo: string | null = null;
      if (isPerm && tripId && attachments.length > 0) {
        const pdfAtt = attachments.find((a) => a.content_type === "application/pdf") ?? attachments[0];

        // Find overflight or landing permit clearances without files
        const { data: clearances } = await supa
          .from("intl_trip_clearances")
          .select("id, clearance_type, status, file_gcs_key")
          .eq("trip_id", tripId)
          .in("clearance_type", ["overflight_permit", "landing_permit"]);

        // Prefer clearances without a file already
        const noFile = (clearances ?? []).filter((c) => !c.file_gcs_key);
        const target = noFile[0] ?? clearances?.[0];

        if (target) {
          await supa.from("intl_trip_clearances").update({
            file_gcs_bucket: pdfAtt.gcs_bucket,
            file_gcs_key: pdfAtt.gcs_key,
            file_filename: pdfAtt.name,
            file_content_type: pdfAtt.content_type,
            status: "approved",
            notes: `Permit from Pinnacle (auto-attached ${new Date().toISOString().slice(0, 10)})`,
          }).eq("id", target.id);
          attachedTo = target.id;
          clearanceId = target.id;
          stats.permitsAttached++;
        }
      }

      // Log in intl_cbp_replies (reuse table for all email types)
      await supa.from("intl_cbp_replies").insert({
        message_id: msg.id, trip_id: tripId, clearance_id: clearanceId,
        from_address: fromAddr, subject: msg.subject,
        status: isPerm ? "approved" : "info",
        log_number: null, officer: null,
        raw_body: msg.body.content.substring(0, 10000),
        match_confidence: matchConfidence,
        attachments: attachments.length > 0 ? attachments : [],
      });

      stats.pinnacle++;
      results.push({ category: "pinnacle", subject: msg.subject, tripId, attachedTo, attachments: attachments.length });
    }

    // ── Handler/FBO confirmations ────────────────────────────────────
    else if (category === "handler") {
      const { status: handlerStatus, note } = parseHandlerBody(msg.body.content);

      // Try to match to a clearance by airport from the email address
      // FBO addresses often have airport codes: sjufbo@, PLSFrontDesk@, pty@, anu@, SXMFrontDesk@
      const addrPart = fromAddr.split("@")[0].toUpperCase();
      const icaoAliases: Record<string, string> = {
        SJU: "TJSJ", STT: "TIST", STX: "TISX", SXM: "TNCM",
        PTY: "MPTO", PLS: "MBPV", ANU: "TAPA", NAS: "MYNN",
        PVD: "KPVD", MDW: "KMDW", FLL: "KFLL",
      };
      let handlerIcao: string | null = null;
      for (const [code, icao] of Object.entries(icaoAliases)) {
        if (addrPart.includes(code)) { handlerIcao = icao; break; }
      }
      // Also try K-prefix from address (e.g., kfllops@)
      const kMatch = addrPart.match(/\b(K[A-Z]{2,3})\b/);
      if (!handlerIcao && kMatch) handlerIcao = kMatch[1];

      if (tripId && handlerIcao) {
        const { data: clearances } = await supa
          .from("intl_trip_clearances")
          .select("id, airport_icao, clearance_type")
          .eq("trip_id", tripId);
        const match = (clearances ?? []).find((c) => c.airport_icao === handlerIcao);
        if (match) clearanceId = match.id;
      }

      // Update handler_status on the clearance
      if (clearanceId) {
        await supa.from("intl_trip_clearances").update({
          handler_status: {
            status: handlerStatus,
            from: fromAddr,
            note,
            date: new Date(msg.receivedDateTime).toISOString().slice(0, 10),
          },
        }).eq("id", clearanceId);
      }

      // Log it
      await supa.from("intl_cbp_replies").insert({
        message_id: msg.id, trip_id: tripId, clearance_id: clearanceId,
        from_address: fromAddr, subject: msg.subject,
        status: handlerStatus === "confirmed" ? "approved" : "info",
        log_number: null, officer: null,
        raw_body: msg.body.content.substring(0, 10000),
        match_confidence: matchConfidence,
        attachments: [],
      });

      stats.handler++;
      results.push({ category: "handler", subject: msg.subject, handlerStatus, note, tripId, clearanceId, handlerIcao });
    }
  }

  return NextResponse.json({
    ok: true,
    messagesScanned: allMessages.length,
    ...stats,
    results,
  });
}
