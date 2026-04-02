import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed, verifyCronSecret } from "@/lib/api-auth";
import { parseFuelCSV } from "@/lib/fuelParsers";

const FUEL_MAILBOX = "fuel@baker-aviation.com";

/**
 * GET|POST /api/fuel-prices/advertised/pull-mailbox
 *
 * Pulls new emails from fuel@baker-aviation.com, downloads CSV attachments,
 * auto-detects vendor format, parses, and upserts into fbo_advertised_prices.
 *
 * Query params:
 *   lookback_minutes (default 720) — how far back to scan
 *   max_messages (default 50) — max emails to process
 *
 * Requires MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET env vars.
 * Auth: CRON_SECRET (Vercel Cron) OR authenticated user session (manual pull).
 */

async function checkAuth(req: NextRequest): Promise<NextResponse | null> {
  // Accept CRON_SECRET (Vercel Cron)
  if (verifyCronSecret(req)) {
    return null;
  }

  // Accept regular user auth (manual "Pull Now" from dashboard)
  const auth = await requireAuth(req);
  if (isAuthed(auth)) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Vercel Cron calls GET
export async function GET(req: NextRequest) {
  return handlePull(req);
}

// Manual triggers use POST
export async function POST(req: NextRequest) {
  return handlePull(req);
}

async function handlePull(req: NextRequest) {
  const authError = await checkAuth(req);
  if (authError) return authError;

  const lookbackMinutes = Number(req.nextUrl.searchParams.get("lookback_minutes") || "2880");
  const maxMessages = Number(req.nextUrl.searchParams.get("max_messages") || "50");
  // Default to searching all folders — some vendor emails land in subfolders
  const allFolders = req.nextUrl.searchParams.get("all_folders") !== "false";
  const force = req.nextUrl.searchParams.get("force") === "true";

  try {
    const token = await getGraphToken();
    const messages = await listRecentMessages(token, lookbackMinutes, maxMessages, allFolders);

    const supa = createServiceClient();
    const results: { messageId: string; subject: string; files: { name: string; vendor: string; format: string; rows: number; error?: string }[] }[] = [];
    let totalInserted = 0;
    let totalSkipped = 0;
    let messagesProcessed = 0;

    for (const msg of messages) {
      // Check if already processed (skip unless force=true)
      if (!force) {
        const { data: existing } = await supa
          .from("fuel_mailbox_processed")
          .select("id")
          .eq("message_id", msg.id)
          .maybeSingle();

        if (existing) continue;
      }

      const attachments = await listAttachments(token, msg.id);
      const csvAttachments = attachments.filter((a) =>
        a.name.toLowerCase().endsWith(".csv") && !a.isInline
      );

      if (csvAttachments.length === 0) {
        // Mark as processed even with no CSVs (so we don't re-check)
        await supa.from("fuel_mailbox_processed").upsert({
          message_id: msg.id,
          subject: msg.subject,
          received_at: msg.receivedDateTime,
          sender: msg.from?.emailAddress?.address ?? null,
          attachments_found: 0,
          attachments_parsed: 0,
          status: "no_csv",
        }, { onConflict: "message_id" });
        continue;
      }

      const fileResults: { name: string; vendor: string; format: string; rows: number; error?: string }[] = [];

      for (const att of csvAttachments) {
        try {
          const csvText = await downloadAttachmentText(token, msg.id, att.id, att.contentBytes);
          const batchId = `auto-${Date.now()}-fuel-mailbox`;
          let parsed = parseFuelCSV(csvText, att.name, batchId);

          // If week_start couldn't be determined from filename, fall back to email received date
          if (parsed.error?.includes("week_start")) {
            const emailDate = msg.receivedDateTime?.split("T")[0] ?? null;
            parsed = parseFuelCSV(csvText, att.name, batchId, null, emailDate);
          }

          if (parsed.error) {
            fileResults.push({ name: att.name, vendor: parsed.vendor, format: parsed.format, rows: 0, error: parsed.error });
            continue;
          }

          if (parsed.rows.length === 0) {
            fileResults.push({ name: att.name, vendor: parsed.vendor, format: parsed.format, rows: 0, error: "No valid rows" });
            continue;
          }

          // Delete old records for this vendor + week
          const weekStarts = [...new Set(parsed.rows.map((r) => r.week_start))];
          for (const ws of weekStarts) {
            await supa
              .from("fbo_advertised_prices")
              .delete()
              .eq("fbo_vendor", parsed.vendor)
              .eq("week_start", ws);
          }

          // Upsert in batches
          let inserted = 0;
          for (let i = 0; i < parsed.rows.length; i += 500) {
            const batch = parsed.rows.slice(i, i + 500);
            const { data } = await supa
              .from("fbo_advertised_prices")
              .upsert(batch, {
                onConflict: "fbo_vendor,airport_code,volume_tier,tail_numbers,week_start",
                ignoreDuplicates: false,
              })
              .select("id");
            inserted += data?.length ?? 0;
          }

          totalInserted += inserted;
          totalSkipped += parsed.rows.length - inserted;
          fileResults.push({ name: att.name, vendor: parsed.vendor, format: parsed.format, rows: inserted });
        } catch (e) {
          fileResults.push({ name: att.name, vendor: "unknown", format: "unknown", rows: 0, error: String(e) });
        }
      }

      // Record this message as processed
      const parsedCount = fileResults.filter((f) => f.rows > 0).length;
      await supa.from("fuel_mailbox_processed").upsert({
        message_id: msg.id,
        subject: msg.subject,
        received_at: msg.receivedDateTime,
        sender: msg.from?.emailAddress?.address ?? null,
        attachments_found: csvAttachments.length,
        attachments_parsed: parsedCount,
        status: parsedCount > 0 ? "parsed" : "failed",
        details: JSON.stringify(fileResults),
      }, { onConflict: "message_id" });

      results.push({ messageId: msg.id, subject: msg.subject, files: fileResults });
      messagesProcessed++;
    }

    // Log pipeline run for health monitoring
    await supa.from("pipeline_runs").insert({
      pipeline: "fuel-mailbox-pull",
      status: "ok",
      message: `messages=${messages.length} new=${messagesProcessed} inserted=${totalInserted}`,
      items: totalInserted,
    });

    // Cleanup: delete advertised prices older than 30 days
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    await supa
      .from("fbo_advertised_prices")
      .delete()
      .lt("week_start", cutoff30d);

    return NextResponse.json({
      ok: true,
      messagesScanned: messages.length,
      messagesProcessed,
      totalInserted,
      totalSkipped,
      results,
    });
  } catch (e) {
    console.error("[fuel/pull-mailbox] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Microsoft Graph API helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function getGraphToken(): Promise<string> {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Missing MS_TENANT_ID, MS_CLIENT_ID, or MS_CLIENT_SECRET env vars");
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  return json.access_token;
}

type GraphMessage = {
  id: string;
  subject: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string } };
};

async function listRecentMessages(token: string, lookbackMinutes: number, maxMessages: number, allFolders = false): Promise<GraphMessage[]> {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  const sinceIso = since.toISOString();

  // Search all folders (including subfolders) or just Inbox
  const endpoint = allFolders
    ? `https://graph.microsoft.com/v1.0/users/${FUEL_MAILBOX}/messages`
    : `https://graph.microsoft.com/v1.0/users/${FUEL_MAILBOX}/mailFolders/Inbox/messages`;
  const url = new URL(endpoint);
  const pageSize = Math.min(maxMessages, 100);
  url.searchParams.set("$top", String(pageSize));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$filter", `receivedDateTime ge ${sinceIso}`);
  url.searchParams.set("$select", "id,subject,receivedDateTime,from,hasAttachments");

  const allMessages: GraphMessage[] = [];
  let nextUrl: string | null = url.toString();

  while (nextUrl && allMessages.length < maxMessages) {
    const pageRes: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!pageRes.ok) {
      const text = await pageRes.text();
      throw new Error(`Graph list messages failed: ${pageRes.status} ${text}`);
    }

    const json = await pageRes.json();
    const page: GraphMessage[] = json.value ?? [];
    allMessages.push(...page);
    nextUrl = json["@odata.nextLink"] ?? null;
  }

  // Only return messages that have attachments
  return allMessages
    .slice(0, maxMessages)
    .filter((m: GraphMessage & { hasAttachments?: boolean }) => m.hasAttachments);
}

type GraphAttachment = {
  id: string;
  name: string;
  contentType: string;
  isInline: boolean;
  contentBytes?: string; // base64-encoded content for small attachments
  size: number;
};

async function listAttachments(token: string, messageId: string): Promise<GraphAttachment[]> {
  const url = `https://graph.microsoft.com/v1.0/users/${FUEL_MAILBOX}/messages/${encodeURIComponent(messageId)}/attachments`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph list attachments failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  return json.value ?? [];
}

async function downloadAttachmentText(
  token: string,
  messageId: string,
  attachmentId: string,
  contentBytes?: string,
): Promise<string> {
  // If contentBytes is already present (small attachments), decode it
  if (contentBytes) {
    return Buffer.from(contentBytes, "base64").toString("utf-8");
  }

  // Otherwise fetch the raw bytes
  const url = `https://graph.microsoft.com/v1.0/users/${FUEL_MAILBOX}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph download attachment failed: ${res.status} ${text}`);
  }

  return res.text();
}
