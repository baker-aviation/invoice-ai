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

function buildEmailBody(candidateName: string, calendlyUrl: string): string {
  const firstName = candidateName.split(/\s+/)[0] || "there";
  return `Hi ${firstName},

Thank you for your interest in Baker Aviation. We'd like to schedule an interview with you.

Please use the link below to select a time that works best for you:

${calendlyUrl}

If you have any questions or need to reschedule, please reply to this email.

Best regards,
Baker Aviation Hiring Team`;
}

/**
 * POST /api/jobs/send-interview-email
 * Body: { application_id: number }
 *
 * Sends the Calendly scheduling email to the candidate.
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

  // Fetch candidate info
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

  // Fetch Calendly URL from settings
  const { data: setting } = await supa
    .from("hiring_settings")
    .select("value")
    .eq("key", "interview_calendly_url")
    .maybeSingle();

  const calendlyUrl = setting?.value;
  if (!calendlyUrl) {
    return NextResponse.json(
      { error: "Calendly URL not configured. Go to Jobs → Admin to set it." },
      { status: 400 },
    );
  }

  // Get MS Graph token and send email
  try {
    const token = await getGraphToken();

    const mailbox = process.env.OUTLOOK_HIRING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
    if (!mailbox) {
      return NextResponse.json(
        { error: "OUTLOOK_HIRING_MAILBOX or OUTLOOK_SHARED_MAILBOX not configured" },
        { status: 500 },
      );
    }

    const emailBody = buildEmailBody(job.candidate_name ?? "there", calendlyUrl);

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
            body: {
              contentType: "Text",
              content: emailBody,
            },
            toRecipients: [
              {
                emailAddress: {
                  address: job.email,
                  name: job.candidate_name ?? undefined,
                },
              },
            ],
          },
          saveToSentItems: true,
        }),
      },
    );

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error("[send-interview-email] Graph sendMail failed:", sendRes.status, errText);
      return NextResponse.json(
        { error: `Failed to send email: ${sendRes.status}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, email: job.email });
  } catch (err: any) {
    console.error("[send-interview-email] Error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to send email" }, { status: 500 });
  }
}
