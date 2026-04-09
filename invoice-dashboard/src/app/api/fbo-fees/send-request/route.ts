import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import {
  buildSubject,
  buildFeeRequestHtml,
  buildFeeRequestPlainText,
  type FeeRequestTarget,
} from "@/lib/fbo-fee-request-email";

const MAILBOX = "operations@baker-aviation.com";

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
  if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * GET /api/fbo-fees/send-request?airport_code=TEB&fbo_name=Atlantic+Aviation
 *
 * Returns a preview of the email that would be sent (subject, html, plaintext).
 * No auth required for preview.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const airportCode = params.get("airport_code") || "TEB";
  const fboName = params.get("fbo_name") || "Example FBO";
  const fboEmail = params.get("fbo_email") || "ops@example.com";

  const target: FeeRequestTarget = {
    airport_code: airportCode,
    fbo_name: fboName,
    fbo_email: fboEmail,
    aircraft_types: ["Challenger 300", "Citation X"],
  };

  return NextResponse.json({
    subject: buildSubject(target),
    html: buildFeeRequestHtml(target),
    plainText: buildFeeRequestPlainText(target),
    target,
  });
}

/**
 * POST /api/fbo-fees/send-request
 *
 * Send fee request emails to FBOs. Supports single or batch.
 *
 * Body: {
 *   targets: Array<{ airport_code, fbo_name, fbo_email }>,
 *   dryRun?: boolean,   // true = create DB rows as 'draft' without sending
 *   batchId?: string,   // optional batch grouping
 * }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: {
    targets: Array<{ airport_code: string; fbo_name: string; fbo_email: string }>;
    dryRun?: boolean;
    batchId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.targets?.length) {
    return NextResponse.json({ error: "targets array required" }, { status: 400 });
  }

  // Validate all targets have emails
  const invalid = body.targets.filter((t) => !t.fbo_email?.includes("@"));
  if (invalid.length) {
    return NextResponse.json({
      error: `${invalid.length} target(s) missing valid email`,
      invalid: invalid.map((t) => `${t.fbo_name} @ ${t.airport_code}`),
    }, { status: 400 });
  }

  const supa = createServiceClient();
  const batchId = body.batchId || `batch_${Date.now()}`;
  const aircraftTypes = ["Challenger 300", "Citation X"];
  const results: Array<{ airport_code: string; fbo_name: string; status: string; error?: string }> = [];

  // For dry run, just create draft rows
  if (body.dryRun) {
    for (const t of body.targets) {
      await supa.from("fbo_fee_requests").insert({
        airport_code: t.airport_code,
        fbo_name: t.fbo_name,
        fbo_email: t.fbo_email,
        aircraft_types: aircraftTypes,
        status: "draft",
        subject: buildSubject({ ...t, aircraft_types: aircraftTypes }),
        batch_id: batchId,
      });
      results.push({ airport_code: t.airport_code, fbo_name: t.fbo_name, status: "draft" });
    }

    return NextResponse.json({ ok: true, dryRun: true, batchId, results, count: results.length });
  }

  // Live send
  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    return NextResponse.json({ error: "Failed to authenticate with email service" }, { status: 500 });
  }

  for (const t of body.targets) {
    const target: FeeRequestTarget = { ...t, aircraft_types: aircraftTypes };

    try {
      const subject = buildSubject(target);
      const htmlContent = buildFeeRequestHtml(target);

      // Step 1: Create draft
      const createRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject,
            body: { contentType: "HTML", content: htmlContent },
            toRecipients: [{ emailAddress: { address: t.fbo_email } }],
          }),
        },
      );

      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Draft failed: ${createRes.status} ${err.slice(0, 200)}`);
      }

      const draft = await createRes.json();

      // Step 2: Send the draft
      const sendRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${draft.id}/send`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );

      if (!sendRes.ok) {
        // Clean up draft
        await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${draft.id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
        ).catch(() => {});
        throw new Error(`Send failed: ${sendRes.status}`);
      }

      // Log to DB
      await supa.from("fbo_fee_requests").insert({
        airport_code: t.airport_code,
        fbo_name: t.fbo_name,
        fbo_email: t.fbo_email,
        aircraft_types: aircraftTypes,
        status: "sent",
        sent_at: new Date().toISOString(),
        subject,
        graph_message_id: draft.id,
        conversation_id: draft.conversationId,
        internet_message_id: draft.internetMessageId,
        batch_id: batchId,
      });

      results.push({ airport_code: t.airport_code, fbo_name: t.fbo_name, status: "sent" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      await supa.from("fbo_fee_requests").insert({
        airport_code: t.airport_code,
        fbo_name: t.fbo_name,
        fbo_email: t.fbo_email,
        aircraft_types: aircraftTypes,
        status: "failed",
        subject: buildSubject(target),
        parse_errors: msg,
        batch_id: batchId,
      });

      results.push({ airport_code: t.airport_code, fbo_name: t.fbo_name, status: "failed", error: msg });
    }

    // Rate limit: ~2 emails/sec max
    await new Promise((r) => setTimeout(r, 500));
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return NextResponse.json({ ok: true, batchId, sent, failed, total: results.length, results });
}
