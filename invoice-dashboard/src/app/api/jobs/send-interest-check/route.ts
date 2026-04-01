import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MS Graph token failed: ${res.status} ${text}`);
  }

  return (await res.json()).access_token;
}

const DEFAULT_TEMPLATE = `Dear {{name}},

Thank you for attending our recent info session! We enjoyed having you.

We'd love to know — are you still interested in pursuing a position with Baker Aviation?

{{yes_button}}

{{no_button}}

If you have any questions, feel free to reply to this email.

Best regards,
Baker Aviation Hiring Team`;

function buildEmail(bodyText: string, logoUrl: string): string {
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

function makeButtons(yesUrl: string, noUrl: string): { yes: string; no: string } {
  return {
    yes: `<div style="text-align:center;margin:20px 0;"><a href="${yesUrl}" style="display:inline-block;padding:14px 36px;background:#059669;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Yes, I'm still interested!</a></div>`,
    no: `<div style="text-align:center;margin:20px 0;"><a href="${noUrl}" style="display:inline-block;padding:14px 36px;background:#6b7280;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">No, thanks</a></div>`,
  };
}

/**
 * POST /api/jobs/send-interest-check
 * Body: { application_ids: number[], force?: boolean }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { application_ids?: number[]; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.application_ids;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "application_ids is required" }, { status: 400 });
  }
  if (ids.length > 100) {
    return NextResponse.json({ error: "Max 100 at a time" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch candidates
  const { data: candidates, error: fetchErr } = await supa
    .from("job_application_parse")
    .select("id, application_id, candidate_name, email, interest_check_sent_at")
    .in("application_id", ids);

  if (fetchErr || !candidates) {
    return NextResponse.json({ error: "Failed to fetch candidates" }, { status: 500 });
  }

  // Fetch email template
  const { data: settings } = await supa
    .from("hiring_settings")
    .select("key, value")
    .in("key", ["still_interested_email_template"]);

  const template = settings?.find((s: any) => s.key === "still_interested_email_template")?.value || DEFAULT_TEMPLATE;

  const origin = req.headers.get("origin") || req.headers.get("x-forwarded-proto") + "://" + req.headers.get("x-forwarded-host") || "https://baker-ai-gamma.vercel.app";
  const logoUrl = `${origin}/logo3.png`;

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

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const candidate of candidates) {
    if (!candidate.email) {
      skipped++;
      continue;
    }

    if (candidate.interest_check_sent_at && !body.force) {
      skipped++;
      continue;
    }

    try {
      // Generate token
      const token = randomBytes(18).toString("base64url");
      const { error: insertErr } = await supa.from("interest_check_tokens").insert({
        token,
        parse_id: candidate.id,
      });

      if (insertErr) {
        errors.push(`${candidate.candidate_name}: token insert failed`);
        continue;
      }

      const baseUrl = origin.replace(/\/$/, "");
      const yesUrl = `${baseUrl}/api/public/interest/${token}?response=yes`;
      const noUrl = `${baseUrl}/api/public/interest/${token}?response=no`;
      const buttons = makeButtons(yesUrl, noUrl);

      const firstName = (candidate.candidate_name ?? "").split(/\s+/)[0] || "there";
      const emailText = template
        .replace(/\{\{name\}\}/g, firstName)
        .replace(/\{\{yes_button\}\}/g, buttons.yes)
        .replace(/\{\{no_button\}\}/g, buttons.no);

      const htmlBody = buildEmail(emailText, logoUrl);

      const sendRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${graphToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject: "Baker Aviation — Are You Still Interested?",
              body: { contentType: "HTML", content: htmlBody },
              toRecipients: [{
                emailAddress: {
                  address: candidate.email,
                  name: candidate.candidate_name ?? undefined,
                },
              }],
            },
            saveToSentItems: true,
          }),
        },
      );

      if (!sendRes.ok) {
        const errText = await sendRes.text();
        errors.push(`${candidate.candidate_name}: send failed (${sendRes.status})`);
        console.error("[send-interest-check]", candidate.email, sendRes.status, errText.slice(0, 200));
        continue;
      }

      // Mark as sent
      const now = new Date().toISOString();
      await supa
        .from("job_application_parse")
        .update({ interest_check_sent_at: now, updated_at: now })
        .eq("application_id", candidate.application_id);

      sent++;
    } catch (err: any) {
      errors.push(`${candidate.candidate_name}: ${err.message}`);
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, errors });
}
