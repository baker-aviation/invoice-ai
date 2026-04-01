import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) throw new Error("MS Graph credentials not configured");

  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) throw new Error(`MS Graph token failed: ${res.status}`);
  return (await res.json()).access_token;
}

function buildHtmlEmail(bodyText: string, logoUrl: string): string {
  const htmlBody = bodyText.replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#333;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="text-align:center;margin-bottom:24px;">
      <img src="${logoUrl}" alt="Baker Aviation" style="height:50px;" />
    </div>
    <div style="font-size:15px;line-height:1.6;">
      ${htmlBody}
    </div>
  </div>
</body>
</html>`;
}

/**
 * POST /api/jobs/send-broadcast
 * Body: { stage: string, subject: string, message: string }
 * Sends a custom email to all candidates in a given pipeline stage.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { stage?: string; subject?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { stage, subject, message } = body;
  if (!stage || !message) {
    return NextResponse.json({ error: "stage and message are required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch all candidates in the target stage with emails
  const { data: candidates, error: fetchErr } = await supa
    .from("job_application_parse")
    .select("application_id, candidate_name, email")
    .eq("pipeline_stage", stage)
    .not("email", "is", null)
    .is("deleted_at", null)
    .is("rejected_at", null);

  if (fetchErr || !candidates) {
    return NextResponse.json({ error: "Failed to fetch candidates" }, { status: 500 });
  }

  const withEmail = candidates.filter((c) => c.email);
  if (withEmail.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No candidates with email in this stage" });
  }

  let graphToken: string;
  try {
    graphToken = await getGraphToken();
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  const mailbox = process.env.OUTLOOK_HR_MAILBOX || process.env.OUTLOOK_HIRING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
  if (!mailbox) {
    return NextResponse.json({ error: "No mailbox configured" }, { status: 500 });
  }

  const origin = "https://baker-ai-gamma.vercel.app";
  const logoUrl = `${origin}/logo3.png`;
  const emailSubject = subject || "Baker Aviation — Update";
  const now = new Date().toISOString();

  let sent = 0;
  const errors: string[] = [];

  for (const candidate of withEmail) {
    try {
      const firstName = (candidate.candidate_name ?? "").split(/\s+/)[0] || "there";
      const personalizedMsg = message.replace(/\{\{name\}\}/g, firstName);
      const htmlBody = buildHtmlEmail(personalizedMsg, logoUrl);

      const sendRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: emailSubject,
              body: { contentType: "HTML", content: htmlBody },
              toRecipients: [{ emailAddress: { address: candidate.email, name: candidate.candidate_name ?? undefined } }],
            },
            saveToSentItems: true,
          }),
        },
      );

      if (!sendRes.ok) {
        errors.push(`${candidate.candidate_name}: ${sendRes.status}`);
        continue;
      }

      // Record announcement sent
      await supa
        .from("job_application_parse")
        .update({ announcement_sent_at: now, updated_at: now })
        .eq("application_id", candidate.application_id);

      sent++;
    } catch (err: any) {
      errors.push(`${candidate.candidate_name}: ${err.message}`);
    }
  }

  return NextResponse.json({ ok: true, sent, total: withEmail.length, errors });
}
