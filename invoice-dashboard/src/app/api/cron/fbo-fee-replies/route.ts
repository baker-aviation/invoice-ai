import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

const MAILBOX = "operations@baker-aviation.com";

async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) throw new Error("MS Graph creds missing");

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

// ---------------------------------------------------------------------------
// AI fee parser
// ---------------------------------------------------------------------------

const FEE_PARSE_PROMPT = `You are an aviation FBO fee data extractor. Given an email reply from an FBO,
extract all fee information into structured JSON.

Return ONLY valid JSON with this exact structure (use null for fees not mentioned):
{
  "aircraft_fees": {
    "<aircraft_type>": {
      "jet_a_price": <number or null>,
      "facility_fee": <number or null>,
      "handling_fee": <number or null>,
      "gallons_to_waive": <number or null>,
      "infrastructure_fee": <number or null>,
      "security_fee": <number or null>,
      "overnight_fee": <number or null>,
      "hangar_fee": <number or null>,
      "hangar_hourly": <number or null>,
      "hangar_info": "<string describing hangar pricing, e.g. '$500 flat + $50/hr'>",
      "gpu_fee": <number or null>,
      "lavatory_fee": <number or null>,
      "deice_fee": <number or null>,
      "afterhours_fee": <number or null>,
      "callout_fee": <number or null>,
      "ramp_fee": <number or null>,
      "parking_info": "<string or empty>"
    }
  },
  "notes": "<any extra context, caveats, or seasonal notes>"
}

Rules:
- All dollar amounts as plain numbers (no $ sign). E.g. 1295.00 not "$1,295"
- gallons_to_waive is an integer (number of gallons)
- If a fee is "included" or "waived", set it to 0
- If fees are the same for all aircraft, duplicate under each type
- If the email mentions aircraft types not in our list, map to closest: "Challenger 300" or "Citation X"
- "Handling fee" and "facility fee" are often the same thing — use facility_fee for the main fee
- jet_a_price should be the RETAIL/posted rate, not contract fuel pricing
- Hangar fees often have a flat rate + hourly: put flat in hangar_fee, hourly in hangar_hourly, full description in hangar_info
- parking_info is a text description of parking terms (e.g. "Complimentary first hour, then $40/hr")
- If the response is clearly not a fee schedule (e.g. "out of office", "unsubscribe"), return: {"error": "not_a_fee_response"}`;

interface ParsedFees {
  aircraft_fees?: Record<string, Record<string, number | string | null>>;
  notes?: string;
  error?: string;
}

async function parseFeesWithAI(emailBody: string, fboName: string, airportCode: string): Promise<ParsedFees> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `FBO: ${fboName} at ${airportCode}\nAircraft types requested: Challenger 300, Citation X\n\nEmail reply:\n---\n${emailBody.slice(0, 8000)}\n---\n\nExtract the fee data as JSON.`,
      },
    ],
    system: FEE_PARSE_PROMPT,
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  // Extract JSON from response (may have markdown code fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in AI response");
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------------
// Main cron handler
// ---------------------------------------------------------------------------

/**
 * GET /api/cron/fbo-fee-replies
 *
 * Pulls replies from the operations mailbox, matches to sent fee requests
 * via conversationId, parses fee data with AI, and upserts to fbo_direct_fees.
 */
export async function GET(req: NextRequest) {
  // Auth: cron secret or dev mode
  if (process.env.NODE_ENV === "production") {
    const secret = req.nextUrl.searchParams.get("secret");
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supa = createServiceClient();

  // Get all requests in "sent" status (waiting for replies)
  const { data: pendingRequests } = await supa
    .from("fbo_fee_requests")
    .select("id, conversation_id, subject, airport_code, fbo_name, fbo_email, aircraft_types, sent_at")
    .eq("status", "sent");

  if (!pendingRequests?.length) {
    return NextResponse.json({ ok: true, message: "No pending requests", checked: 0 });
  }

  // Build lookup maps: by conversationId (if available) and by subject+sender email
  const convMap = new Map<string, (typeof pendingRequests)[0]>();
  const subjectMap = new Map<string, (typeof pendingRequests)[0]>();
  for (const r of pendingRequests) {
    if (r.conversation_id) convMap.set(r.conversation_id, r);
    if (r.subject && r.fbo_email) {
      subjectMap.set(`${r.subject.toLowerCase()}|${r.fbo_email.toLowerCase()}`, r);
    }
  }

  let token: string;
  try {
    token = await getGraphToken();
  } catch (err) {
    return NextResponse.json({ error: "Graph auth failed" }, { status: 500 });
  }

  // Pull recent inbox messages (last 3 days, up to 100)
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const filter = `receivedDateTime ge ${since}`;
  const inboxRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/Inbox/messages?$filter=${encodeURIComponent(filter)}&$top=100&$select=id,conversationId,from,subject,body,receivedDateTime,internetMessageId&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!inboxRes.ok) {
    return NextResponse.json({ error: `Inbox fetch failed: ${inboxRes.status}` }, { status: 500 });
  }

  const inbox = await inboxRes.json();
  const messages: Array<{
    id: string;
    conversationId: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    body: { content: string };
    receivedDateTime: string;
    internetMessageId: string;
  }> = inbox.value || [];

  let matched = 0;
  let parsed = 0;
  let errors = 0;

  for (const msg of messages) {
    // Skip if this is our own sent message
    if (msg.from.emailAddress.address.toLowerCase() === MAILBOX.toLowerCase()) continue;

    // Match by: 1) ref ID in body, 2) conversationId, 3) subject+sender
    let request: (typeof pendingRequests)[0] | undefined;

    // Check for BA-FEE-{id} ref code in the reply body
    const refMatch = msg.body.content.match(/BA-FEE-(\d+)/);
    if (refMatch) {
      const refId = parseInt(refMatch[1], 10);
      request = pendingRequests.find((r) => r.id === refId);
    }

    if (!request) {
      request = convMap.get(msg.conversationId);
    }
    if (!request) {
      const replySubject = msg.subject.replace(/^(RE|Re|re|FW|Fw|fw):\s*/g, "").toLowerCase();
      const senderEmail = msg.from.emailAddress.address.toLowerCase();
      request = subjectMap.get(`${replySubject}|${senderEmail}`);
    }
    if (!request) continue;

    matched++;

    // Strip HTML tags for plain text parsing
    const plainBody = msg.body.content
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    // Update request as replied
    await supa
      .from("fbo_fee_requests")
      .update({
        status: "replied",
        reply_received_at: msg.receivedDateTime,
        reply_message_id: msg.internetMessageId,
        reply_body: plainBody.slice(0, 50000),
        reply_from: msg.from.emailAddress.address,
      })
      .eq("id", request.id);

    // Parse with AI
    try {
      const fees = await parseFeesWithAI(plainBody, request.fbo_name, request.airport_code);

      if (fees.error) {
        await supa
          .from("fbo_fee_requests")
          .update({ parse_confidence: "failed", parse_errors: fees.error, parsed_at: new Date().toISOString() })
          .eq("id", request.id);
        continue;
      }

      if (!fees.aircraft_fees) {
        await supa
          .from("fbo_fee_requests")
          .update({ parse_confidence: "failed", parse_errors: "No aircraft_fees in parsed output", parsed_at: new Date().toISOString() })
          .eq("id", request.id);
        continue;
      }

      // Upsert to fbo_direct_fees for each aircraft type
      for (const [acType, acFees] of Object.entries(fees.aircraft_fees)) {
        // Normalize aircraft type name
        const normalizedType = acType.toLowerCase().includes("challenger") ? "Challenger 300"
          : acType.toLowerCase().includes("citation") ? "Citation X"
          : acType;

        await supa.from("fbo_direct_fees").upsert(
          {
            airport_code: request.airport_code,
            fbo_name: request.fbo_name,
            aircraft_type: normalizedType,
            jet_a_price: acFees.jet_a_price ?? null,
            facility_fee: acFees.facility_fee ?? null,
            gallons_to_waive: acFees.gallons_to_waive ?? null,
            security_fee: acFees.security_fee ?? null,
            overnight_fee: acFees.overnight_fee ?? null,
            hangar_fee: acFees.hangar_fee ?? null,
            gpu_fee: acFees.gpu_fee ?? null,
            lavatory_fee: acFees.lavatory_fee ?? null,
            deice_fee: acFees.deice_fee ?? null,
            afterhours_fee: acFees.afterhours_fee ?? null,
            callout_fee: acFees.callout_fee ?? null,
            ramp_fee: acFees.ramp_fee ?? null,
            parking_info: typeof acFees.parking_info === "string" ? acFees.parking_info : "",
            landing_fee: null,
            source_email: msg.from.emailAddress.address,
            source_date: new Date(msg.receivedDateTime).toISOString().split("T")[0],
            raw_response: plainBody.slice(0, 50000),
            confidence: "ai-parsed",
          },
          { onConflict: "airport_code,fbo_name,aircraft_type" },
        );
      }

      await supa
        .from("fbo_fee_requests")
        .update({ status: "parsed", parse_confidence: "ai-parsed", parsed_at: new Date().toISOString() })
        .eq("id", request.id);

      parsed++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await supa
        .from("fbo_fee_requests")
        .update({ parse_confidence: "failed", parse_errors: errMsg.slice(0, 1000), parsed_at: new Date().toISOString() })
        .eq("id", request.id);
      errors++;
    }
  }

  return NextResponse.json({
    ok: true,
    pendingRequests: pendingRequests.length,
    inboxMessages: messages.length,
    matched,
    parsed,
    errors,
  });
}
