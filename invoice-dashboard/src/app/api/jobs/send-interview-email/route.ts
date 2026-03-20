import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const SAFE_ID_RE = /^\d+$/;

async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenant || !clientId || !clientSecret) {
    throw new Error("MS Graph credentials not configured (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)");
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
    throw new Error(`MS Graph token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

const DEFAULT_TEMPLATE = `Dear {{name}},

Thank you for your interest in Baker Aviation. We'd like to invite you to schedule an interview with our team.

Please use the link below to select a time that works best for you:

{{calendly_url}}

If you have any questions or need to reschedule, please reply to this email.

We look forward to speaking with you!

Sincerely,
Baker Aviation Hiring Team`;

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
 * POST /api/jobs/send-interview-email
 * Body: { application_id: number }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { application_id?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const appId = body.application_id;
  if (!appId || !SAFE_ID_RE.test(String(appId))) {
    return NextResponse.json({ error: "Invalid application_id" }, { status: 400 });
  }

  const supa = createServiceClient();

  const { data: job, error: jobErr } = await supa
    .from("job_application_parse")
    .select("candidate_name, email, pipeline_stage")
    .eq("application_id", appId)
    .maybeSingle();

  if (jobErr || !job) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  if (!job.email) {
    return NextResponse.json({ error: "Candidate has no email address" }, { status: 400 });
  }

  // Fetch Calendly URL and email template from settings
  const { data: settings } = await supa
    .from("hiring_settings")
    .select("key, value")
    .in("key", ["interview_calendly_url", "interview_email_template"]);

  const calendlyUrl = settings?.find((s: any) => s.key === "interview_calendly_url")?.value;
  if (!calendlyUrl) {
    return NextResponse.json(
      { error: "Calendly URL not configured. Go to Jobs → Admin to set it." },
      { status: 400 },
    );
  }

  const template = settings?.find((s: any) => s.key === "interview_email_template")?.value || DEFAULT_TEMPLATE;

  try {
    const token = await getGraphToken();
    const mailbox = process.env.OUTLOOK_HR_MAILBOX || process.env.OUTLOOK_HIRING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
    if (!mailbox) {
      return NextResponse.json({ error: "No mailbox configured" }, { status: 500 });
    }

    const firstName = (job.candidate_name ?? "").split(/\s+/)[0] || "there";
    const emailText = template
      .replace(/\{\{name\}\}/g, firstName)
      .replace(/\{\{calendly_url\}\}/g, calendlyUrl);

    const origin = req.headers.get("origin") || "https://baker-ai-gamma.vercel.app";
    const logoUrl = `${origin}/logo3.png`;
    const htmlBody = buildHtmlEmail(emailText, logoUrl);

    const sendRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: "Baker Aviation — Interview Scheduling",
            body: { contentType: "HTML", content: htmlBody },
            toRecipients: [{
              emailAddress: {
                address: job.email,
                name: job.candidate_name ?? undefined,
              },
            }],
          },
          saveToSentItems: true,
        }),
      },
    );

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error("[send-interview-email] Graph sendMail failed:", sendRes.status, errText);
      return NextResponse.json({ error: `Email send failed (HTTP ${sendRes.status})`, detail: errText.slice(0, 300) }, { status: 500 });
    }

    return NextResponse.json({ ok: true, email: job.email });
  } catch (err: any) {
    console.error("[send-interview-email] Error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to send email" }, { status: 500 });
  }
}
