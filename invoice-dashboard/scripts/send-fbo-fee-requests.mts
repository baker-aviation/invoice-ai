/**
 * Send FBO fee request emails from draft rows in fbo_fee_requests.
 * Processes drafts in batches with rate limiting — no timeout.
 *
 * Usage:
 *   node --experimental-strip-types scripts/send-fbo-fee-requests.mts              # send all drafts
 *   node --experimental-strip-types scripts/send-fbo-fee-requests.mts --limit 50   # send first 50
 *   node --experimental-strip-types scripts/send-fbo-fee-requests.mts --dry-run    # just show what would send
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { buildSubject, buildFeeRequestHtml } from "../src/lib/fbo-fee-request-email.js";

const DELAY_MS = 1500; // 1.5s between emails — well within Graph limits
const MAILBOX = "operations@baker-aviation.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getGraphToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID!,
        client_secret: process.env.MS_CLIENT_SECRET!,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  // Get draft rows
  let query = supa
    .from("fbo_fee_requests")
    .select("*")
    .eq("status", "draft")
    .order("created_at", { ascending: true });

  if (limit) query = query.limit(limit);

  const { data: drafts, error } = await query;

  if (error) {
    console.error("DB error:", error.message);
    process.exit(1);
  }

  if (!drafts?.length) {
    console.log("No drafts to send.");
    return;
  }

  console.log(`${drafts.length} drafts to send${dryRun ? " (DRY RUN)" : ""}`);

  if (dryRun) {
    for (const d of drafts) {
      console.log(`  ${d.airport_code.padEnd(5)} ${d.fbo_name.padEnd(35)} → ${d.fbo_email}`);
    }
    console.log(`\nRun without --dry-run to send. Estimated time: ${Math.ceil(drafts.length * DELAY_MS / 60000)} min`);
    return;
  }

  let token = await getGraphToken();
  console.log("Got Graph token");

  let sent = 0;
  let failed = 0;
  const tokenRefreshInterval = 45 * 60 * 1000; // refresh token every 45 min
  let tokenTime = Date.now();

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];

    // Refresh token if it's been a while
    if (Date.now() - tokenTime > tokenRefreshInterval) {
      token = await getGraphToken();
      tokenTime = Date.now();
      console.log("\n  [Token refreshed]");
    }

    const target = {
      airport_code: d.airport_code,
      fbo_name: d.fbo_name,
      fbo_email: d.fbo_email,
      aircraft_types: d.aircraft_types || ["Challenger 300", "Citation X"],
    };

    try {
      const subject = buildSubject(target);
      const htmlContent = buildFeeRequestHtml(target);

      // Create draft in Graph
      const createRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject,
            body: { contentType: "HTML", content: htmlContent },
            toRecipients: [{ emailAddress: { address: d.fbo_email } }],
          }),
        },
      );

      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Draft failed: ${createRes.status} ${err.slice(0, 200)}`);
      }

      const draft = await createRes.json();

      // Send it
      const sendRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${draft.id}/send`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );

      if (!sendRes.ok) {
        await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${draft.id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
        ).catch(() => {});
        throw new Error(`Send failed: ${sendRes.status}`);
      }

      // Update DB
      await supa
        .from("fbo_fee_requests")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          subject,
          graph_message_id: draft.id,
          conversation_id: draft.conversationId,
          internet_message_id: draft.internetMessageId,
        })
        .eq("id", d.id);

      sent++;
      process.stdout.write("✓");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supa
        .from("fbo_fee_requests")
        .update({ status: "failed", parse_errors: msg.slice(0, 500) })
        .eq("id", d.id);
      failed++;
      process.stdout.write("!");
      if (failed <= 3) console.error(`\n  ${d.airport_code} ${d.fbo_name}: ${msg}`);
    }

    await sleep(DELAY_MS);

    if ((i + 1) % 25 === 0) {
      console.log(`\n  [${i + 1}/${drafts.length}] Sent: ${sent}, Failed: ${failed}`);
    }
  }

  console.log(`\n\nDone! Sent: ${sent}, Failed: ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
