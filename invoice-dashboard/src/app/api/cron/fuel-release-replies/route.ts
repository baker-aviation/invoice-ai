import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret, requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { listMailboxMessages, downloadMailboxAttachments } from "@/lib/graph-mail-send";
import { postSlackMessage, resolveFuelSlackChannel } from "@/lib/slack";

export const dynamic = "force-dynamic";

const OPS_MAILBOX = "operations@baker-aviation.com";

/**
 * Regex to extract our reference code from email subjects.
 * Matches patterns like [BR-1A2B3C4D] anywhere in the subject.
 */
const REF_CODE_RE = /\[BR-([A-Z0-9]{8})\]/i;

/**
 * GET /api/cron/fuel-release-replies
 *
 * Polls the operations mailbox for replies to fuel release emails.
 * Matches replies by the [BR-xxxxxxxx] reference code in the subject line,
 * updates the fuel_releases row, and sends a Slack notification.
 *
 * Called by:
 * - Graph webhook (fire-and-forget when new email arrives)
 * - Vercel Cron (fallback, every 15 minutes)
 */
export async function GET(req: NextRequest) {
  // Auth: cron secret OR authenticated user
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const auth = await requireAuth(req);
    if (!isAuthed(auth)) return auth.error;
  }

  const supa = createServiceClient();

  // Get pending/confirmed releases that have a ref code (vendor_confirmation starting with BR-)
  const { data: pendingReleases, error: relErr } = await supa
    .from("fuel_releases")
    .select("id, vendor_confirmation, tail_number, airport_code, fbo_name, vendor_name, status, status_history, reply_attachments")
    .in("status", ["pending"])
    .not("vendor_confirmation", "is", null)
    .like("vendor_confirmation", "BR-%");

  if (relErr || !pendingReleases?.length) {
    return NextResponse.json({
      ok: true,
      message: relErr ? `DB error: ${relErr.message}` : "No pending email releases",
      checked: 0,
      matched: 0,
    });
  }

  // Build a map of ref code → release for quick lookup
  const refMap = new Map<string, typeof pendingReleases[0]>();
  for (const r of pendingReleases) {
    if (r.vendor_confirmation) {
      refMap.set(r.vendor_confirmation.toUpperCase(), r);
    }
  }

  // Poll mailbox for recent messages (last 4 hours)
  let messages;
  try {
    messages = await listMailboxMessages({
      mailbox: OPS_MAILBOX,
      lookbackMinutes: 240,
      maxMessages: 100,
    });
  } catch (err) {
    console.error("[fuel-release-replies] Graph error:", err);
    return NextResponse.json(
      { error: `Failed to read mailbox: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // Check which messages have already been processed
  const messageIds = messages.map((m) => m.id);
  const { data: processed } = await supa
    .from("fuel_release_email_log")
    .select("graph_message_id")
    .in("graph_message_id", messageIds.length > 0 ? messageIds : ["__none__"]);

  const processedSet = new Set(processed?.map((p) => p.graph_message_id) ?? []);

  let matched = 0;

  for (const msg of messages) {
    // Skip already-processed messages
    if (processedSet.has(msg.id)) continue;

    // Check if subject contains a ref code
    const match = msg.subject?.match(REF_CODE_RE);
    if (!match) continue;

    const refCode = `BR-${match[1].toUpperCase()}`;
    const release = refMap.get(refCode);
    if (!release) continue;

    // Skip if the sender is operations@ itself (our own outgoing emails land in mailbox too)
    const fromAddr = (msg.from || "").toLowerCase();
    if (fromAddr.includes("operations@baker-aviation.com") || fromAddr.startsWith("/")) {
      continue;
    }

    // We have a match — this is a reply to one of our fuel release emails
    matched++;

    // Strip Baker Aviation external caution banner from reply preview
    const cleanedPreview = (msg.bodyPreview ?? "")
      .replace(/CAUTION:[^\n]*?open attachments unless[^\n]*/i, "")
      .replace(/^\s*\[[^\]]+\]\s*/, "")
      .trim();

    // Determine status from reply content (simple keyword matching)
    const bodyLower = (cleanedPreview + " " + (msg.body ?? "")).toLowerCase();
    let newStatus = "confirmed"; // Default: any reply = confirmed
    if (
      bodyLower.includes("reject") ||
      bodyLower.includes("denied") ||
      bodyLower.includes("unable") ||
      bodyLower.includes("cannot") ||
      bodyLower.includes("not available")
    ) {
      newStatus = "rejected";
    }

    const now = new Date().toISOString();

    // Pull PDF attachments from the reply email and stash them on GCS.
    // We accept PDFs + common image mimetypes; ignore everything else to
    // avoid storing noise (e.g. signature logos marked non-inline).
    let savedAttachments: Array<{ name: string; gcs_key: string; gcs_bucket: string; content_type: string; size: number; uploaded_at: string; message_id: string }> = [];
    if (msg.hasAttachments) {
      const files = await downloadMailboxAttachments({
        mailbox: OPS_MAILBOX,
        messageId: msg.id,
        gcsPrefix: `fuel-releases/${release.id}`,
        allowedContentTypes: ["application/pdf", "image/"],
      });
      savedAttachments = files.map((f) => ({ ...f, uploaded_at: now, message_id: msg.id }));
    }

    // Append reply entry to status_history (with attachment count so the
    // timeline UI can hint at a PDF without needing the full array).
    const existingHistory = (release.status_history ?? []) as Array<{ status: string; at: string; by: string; note?: string; attachment_count?: number }>;
    const newHistory = [
      ...existingHistory,
      {
        status: newStatus,
        at: msg.receivedDateTime || now,
        by: "email-reply",
        note: `Reply from ${msg.from}: "${cleanedPreview.slice(0, 200)}"`,
        ...(savedAttachments.length > 0 && { attachment_count: savedAttachments.length }),
      },
    ];

    const existingAttachments = (release.reply_attachments ?? []) as Array<Record<string, unknown>>;

    // Update the release
    await supa
      .from("fuel_releases")
      .update({
        status: newStatus,
        status_history: newHistory,
        reply_attachments: [...existingAttachments, ...savedAttachments],
      })
      .eq("id", release.id);

    // Log the processed message
    await supa.from("fuel_release_email_log").insert({
      graph_message_id: msg.id,
      release_id: release.id,
      ref_code: refCode,
      from_email: msg.from,
      subject: msg.subject,
      status_resolved: newStatus,
      received_at: msg.receivedDateTime,
      processed_at: now,
    });

    // Slack notification
    const strip = (c: string) =>
      c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
    const emoji = newStatus === "confirmed" ? ":white_check_mark:" : ":x:";
    const statusLabel = newStatus === "confirmed" ? "Confirmed" : "Rejected";

    // Find the tail's Slack channel
    const { data: src } = await supa
      .from("ics_sources")
      .select("slack_channel_id")
      .eq("label", release.tail_number.toUpperCase())
      .single();
    const channel = await resolveFuelSlackChannel(src?.slack_channel_id ?? null);

    await postSlackMessage({
      channel,
      text: `Fuel release ${statusLabel.toLowerCase()}: ${release.tail_number} at ${strip(release.airport_code)}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `${emoji} *Fuel Release ${statusLabel}*`,
              `*Tail:* ${release.tail_number}  *Airport:* ${strip(release.airport_code)}`,
              `*FBO:* ${release.fbo_name || "—"}  *Vendor:* ${release.vendor_name}`,
              `*Ref:* ${refCode}`,
              `*Reply from:* ${msg.from}`,
              `> ${msg.bodyPreview.slice(0, 200)}`,
            ].join("\n"),
          },
        },
      ],
    });
  }

  return NextResponse.json({
    ok: true,
    checked: messages.length,
    pendingReleases: pendingReleases.length,
    matched,
  });
}
