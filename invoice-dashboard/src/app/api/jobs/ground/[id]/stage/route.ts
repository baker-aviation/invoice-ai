import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { ALL_GROUND_STAGES, isValidGroundStage } from "@/lib/groundPipeline";
import { postSlackMessage } from "@/lib/slack";

const SAFE_ID_RE = /^\d+$/;

// ─── MS Graph email helpers ────────────────────────────────────────────

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

const DEFAULT_PHONE_SCREEN_TEMPLATE = `Dear {{name}},

Thank you for your interest in Baker Aviation! We'd like to schedule a brief phone screen to learn more about your background.

Please use the link below to pick a time that works for you:

{{calendly_link}}

If you have any questions, feel free to reply to this email.

Best regards,
Baker Aviation Hiring Team`;

const DEFAULT_INTERVIEW_TEMPLATE = `Dear {{name}},

We enjoyed speaking with you and would like to invite you to an in-person interview at Baker Aviation.

Please use the link below to schedule your interview:

{{calendly_link}}

If you have any questions, feel free to reply to this email.

Best regards,
Baker Aviation Hiring Team`;

async function sendGroundAutoEmail(
  supa: ReturnType<typeof createServiceClient>,
  applicationId: number,
  type: "phone_screen" | "interview",
): Promise<{ sent: boolean; error?: string }> {
  try {
    const { data: candidate } = await supa
      .from("job_application_parse")
      .select("candidate_name, email")
      .eq("application_id", applicationId)
      .maybeSingle();

    if (!candidate?.email) return { sent: false, error: "no_email" };

    const settingKeys = type === "phone_screen"
      ? ["ground_phone_screen_calendly_url", "ground_phone_screen_email_template"]
      : ["ground_interview_calendly_url", "ground_interview_email_template"];

    const { data: settings } = await supa
      .from("hiring_settings")
      .select("key, value")
      .in("key", settingKeys);

    const urlKey = type === "phone_screen" ? "ground_phone_screen_calendly_url" : "ground_interview_calendly_url";
    const templateKey = type === "phone_screen" ? "ground_phone_screen_email_template" : "ground_interview_email_template";

    const link = settings?.find((s: any) => s.key === urlKey)?.value;
    const template = settings?.find((s: any) => s.key === templateKey)?.value
      || (type === "phone_screen" ? DEFAULT_PHONE_SCREEN_TEMPLATE : DEFAULT_INTERVIEW_TEMPLATE);

    if (!link) return { sent: false, error: `no_${type}_calendly_url_configured` };

    const firstName = (candidate.candidate_name ?? "").split(/\s+/)[0] || "there";
    const emailText = template
      .replace(/\{\{name\}\}/g, firstName)
      .replace(/\{\{calendly_link\}\}/g, link);

    const origin = "https://baker-ai-gamma.vercel.app";
    const htmlBody = buildHtmlEmail(emailText, `${origin}/logo3.png`);

    const graphToken = await getGraphToken();
    const mailbox = process.env.OUTLOOK_HR_MAILBOX || process.env.OUTLOOK_HIRING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
    if (!mailbox) return { sent: false, error: "no_mailbox" };

    const subject = type === "phone_screen"
      ? "Baker Aviation — Phone Screen Scheduling"
      : "Baker Aviation — Interview Scheduling";

    const sendRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: htmlBody },
            toRecipients: [{ emailAddress: { address: candidate.email, name: candidate.candidate_name ?? undefined } }],
          },
          saveToSentItems: true,
        }),
      },
    );

    if (!sendRes.ok) {
      console.error(`[ground/stage] ${type} email send failed:`, sendRes.status);
      return { sent: false, error: `send_failed_${sendRes.status}` };
    }

    return { sent: true };
  } catch (err: any) {
    console.error(`[ground/stage] Auto-email (${type}) error:`, err);
    return { sent: false, error: err.message };
  }
}

// ─── Main endpoint ─────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  if (!SAFE_ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  let body: { stage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stage = body.stage;
  const isRemove = stage === "remove" || stage === null;

  if (!isRemove && (!stage || !ALL_GROUND_STAGES.includes(stage))) {
    return NextResponse.json(
      { error: `Invalid ground stage. Must be one of: remove, ${ALL_GROUND_STAGES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const supa = createServiceClient();

    // Fetch candidate info for validation + Slack
    const { data: candidate } = await supa
      .from("job_application_parse")
      .select("pipeline_stage, category, candidate_name")
      .eq("application_id", Number(id))
      .maybeSingle();

    if (!candidate) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Validate stage is valid for this candidate's category
    if (!isRemove && stage && !isValidGroundStage(stage, candidate.category)) {
      return NextResponse.json(
        { error: `Stage "${stage}" is not valid for category "${candidate.category}"` },
        { status: 400 },
      );
    }

    // Check manager review gate
    if (!isRemove && stage === "background_check" || stage === "driving_record_check") {
      const { data: reviewCheck } = await supa
        .from("job_application_parse")
        .select("manager_review_status")
        .eq("application_id", Number(id))
        .maybeSingle();
      if (reviewCheck?.manager_review_status && reviewCheck.manager_review_status !== "approved") {
        return NextResponse.json(
          { error: "Cannot advance past Manager Review until approved" },
          { status: 400 },
        );
      }
    }

    const updateData: Record<string, any> = {
      pipeline_stage: isRemove ? "" : stage,
      updated_at: new Date().toISOString(),
    };

    // Set manager_review_status to pending when entering that stage
    if (stage === "manager_review") {
      updateData.manager_review_status = "pending";
    }

    const { data, error: updateErr } = await supa
      .from("job_application_parse")
      .update(updateData)
      .eq("application_id", Number(id))
      .select("id");

    if (updateErr) {
      console.error("[ground/stage] Update error:", updateErr);
      return NextResponse.json({ error: `Update failed: ${updateErr.message}` }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Auto-send emails on stage transitions
    let emailResult: { sent: boolean; error?: string } | null = null;

    if (stage === "phone_screen") {
      emailResult = await sendGroundAutoEmail(supa, Number(id), "phone_screen");
    }
    if (stage === "interview") {
      emailResult = await sendGroundAutoEmail(supa, Number(id), "interview");
    }

    // Slack notification
    try {
      const stageLabel = stage === "remove" ? "removed from pipeline" : stage?.replace(/_/g, " ");
      await postSlackMessage({
        channel: process.env.SLACK_HIRING_CHANNEL_ID || "C0AQ54QT98B",
        text: `[Ground] ${candidate.candidate_name ?? "Unknown"} moved to *${stageLabel}*`,
      });
    } catch {
      // Non-blocking
    }

    return NextResponse.json({ ok: true, stage, emailResult });
  } catch (err) {
    console.error("[ground/stage] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
