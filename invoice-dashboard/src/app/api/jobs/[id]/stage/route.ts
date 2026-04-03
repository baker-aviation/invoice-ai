import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PIPELINE_STAGES } from "@/lib/types";
import { getItemsForRole } from "@/lib/onboardingItems";

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

const DEFAULT_INFO_SESSION_TEMPLATE = `Dear {{name}},

Thank you for your interest in Baker Aviation! We'd like to invite you to attend an upcoming information session where you'll learn more about the company, the role, and have the opportunity to ask questions.

Please join using the link below:

{{meet_link}}

If you have any questions beforehand, feel free to reply to this email.

We look forward to seeing you there!

Sincerely,
Baker Aviation Hiring Team`;

const DEFAULT_INTERVIEW_TEMPLATE = `Dear {{name}},

Congratulations! After reviewing your application, we'd like to invite you to interview with Baker Aviation.

Please use the link below to schedule your interview at a time that works for you:

{{calendly_link}}

If you have any questions, feel free to reply to this email.

We look forward to speaking with you!

Sincerely,
Baker Aviation Hiring Team`;

async function sendAutoEmail(
  supa: ReturnType<typeof createServiceClient>,
  applicationId: number,
  type: "info_session" | "interview",
  origin: string,
): Promise<{ sent: boolean; error?: string }> {
  try {
    // Fetch candidate
    const { data: candidate } = await supa
      .from("job_application_parse")
      .select("candidate_name, email, info_session_email_sent_at, interview_email_sent_at")
      .eq("application_id", applicationId)
      .maybeSingle();

    if (!candidate?.email) return { sent: false, error: "no_email" };

    // Skip if already sent
    if (type === "info_session" && candidate.info_session_email_sent_at) return { sent: false, error: "already_sent" };
    if (type === "interview" && candidate.interview_email_sent_at) return { sent: false, error: "already_sent" };

    // Fetch settings
    const settingKeys = type === "info_session"
      ? ["info_session_meet_link", "info_session_email_template"]
      : ["interview_calendly_url", "interview_email_template"];

    const { data: settings } = await supa
      .from("hiring_settings")
      .select("key, value")
      .in("key", settingKeys);

    let template: string;
    let link: string | undefined;

    if (type === "info_session") {
      link = settings?.find((s: any) => s.key === "info_session_meet_link")?.value;
      template = settings?.find((s: any) => s.key === "info_session_email_template")?.value || DEFAULT_INFO_SESSION_TEMPLATE;
    } else {
      link = settings?.find((s: any) => s.key === "interview_calendly_url")?.value;
      template = settings?.find((s: any) => s.key === "interview_email_template")?.value || DEFAULT_INTERVIEW_TEMPLATE;
    }

    if (!link) return { sent: false, error: `no_${type === "info_session" ? "meet_link" : "calendly_url"}_configured` };

    const firstName = (candidate.candidate_name ?? "").split(/\s+/)[0] || "there";
    const emailText = template
      .replace(/\{\{name\}\}/g, firstName)
      .replace(/\{\{meet_link\}\}/g, link)
      .replace(/\{\{calendly_link\}\}/g, link);

    const logoUrl = `${origin}/logo3.png`;
    const htmlBody = buildHtmlEmail(emailText, logoUrl);

    const graphToken = await getGraphToken();
    const mailbox = process.env.OUTLOOK_HR_MAILBOX || process.env.OUTLOOK_HIRING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX;
    if (!mailbox) return { sent: false, error: "no_mailbox" };

    const subject = type === "info_session"
      ? "Baker Aviation — Info Session Invite"
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
      console.error(`[stage] ${type} email send failed:`, sendRes.status);
      return { sent: false, error: `send_failed_${sendRes.status}` };
    }

    // Record sent timestamp
    const now = new Date().toISOString();
    const sentField = type === "info_session" ? "info_session_email_sent_at" : "interview_email_sent_at";
    const statusField = type === "info_session" ? "info_session_email_status" : "interview_email_status";
    await supa
      .from("job_application_parse")
      .update({ [sentField]: now, [statusField]: "sent", updated_at: now })
      .eq("application_id", applicationId);

    return { sent: true };
  } catch (err: any) {
    console.error(`[stage] Auto-email (${type}) error:`, err);
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

  if (!isRemove && (!stage || !(PIPELINE_STAGES as readonly string[]).includes(stage))) {
    return NextResponse.json(
      { error: `Invalid stage. Must be one of: remove, ${PIPELINE_STAGES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const supa = createServiceClient();

    // Fetch previous stage for transition-specific logic
    const { data: prev } = await supa
      .from("job_application_parse")
      .select("pipeline_stage")
      .eq("application_id", Number(id))
      .maybeSingle();
    const previousStage = prev?.pipeline_stage ?? null;

    const { data, error: updateErr } = await supa
      .from("job_application_parse")
      .update({ pipeline_stage: isRemove ? "" : stage })
      .eq("application_id", Number(id))
      .select("id");

    if (updateErr) {
      console.error("[jobs/stage] Update error:", updateErr);
      return NextResponse.json({ error: `Update failed: ${updateErr.message}` }, { status: 500 });
    }

    if (!data || data.length === 0) {
      const { data: check } = await supa
        .from("job_application_parse")
        .select("id, application_id, pipeline_stage")
        .eq("application_id", Number(id))
        .limit(1);
      return NextResponse.json({
        error: "Application not found",
        debug: { id, numericId: Number(id), existingRows: check?.length ?? 0, rows: check },
      }, { status: 404 });
    }

    // Always use production URL for email assets (logo, links)
    const origin = "https://baker-ai-gamma.vercel.app";
    let emailResult: { sent: boolean; error?: string } | null = null;

    // Auto-send info session email
    if (stage === "info_session") {
      emailResult = await sendAutoEmail(supa, Number(id), "info_session", origin);
    }

    // Auto-send interview scheduling email
    if (stage === "interview_scheduled") {
      emailResult = await sendAutoEmail(supa, Number(id), "interview", origin);
    }

    // Auto-send "Still Interested?" email when moving from info_session → prd_faa_review
    let interestCheckSent = false;
    if (stage === "prd_faa_review" && previousStage === "info_session") {
      try {
        const { data: candidate } = await supa
          .from("job_application_parse")
          .select("id, candidate_name, email, interest_check_sent_at")
          .eq("application_id", Number(id))
          .maybeSingle();

        if (candidate?.email && !candidate.interest_check_sent_at) {
          const icRes = await fetch(new URL("/api/jobs/send-interest-check", origin).toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: req.headers.get("cookie") ?? "",
              authorization: req.headers.get("authorization") ?? "",
            },
            body: JSON.stringify({ application_ids: [Number(id)] }),
          });
          const icData = await icRes.json().catch(() => ({}));
          interestCheckSent = icData.sent > 0;
        }
      } catch (err) {
        console.error("[stage] Interest check send failed:", err);
      }
    }

    // Auto-create pilot profile when moved to "hired"
    if (stage === "hired") {
      try {
        const { data: app } = await supa
          .from("job_application_parse")
          .select("candidate_name, email, phone, category")
          .eq("application_id", Number(id))
          .single();

        if (app?.candidate_name) {
          const { data: existing } = await supa
            .from("pilot_profiles")
            .select("id")
            .eq("application_id", Number(id))
            .maybeSingle();

          if (!existing) {
            const role = app.category?.toLowerCase().includes("pic") ? "PIC" : "SIC";

            const { data: pilot } = await supa
              .from("pilot_profiles")
              .insert({
                full_name: app.candidate_name,
                email: app.email ?? null,
                phone: app.phone ?? null,
                role,
                application_id: Number(id),
                hire_date: new Date().toISOString().split("T")[0],
                home_airports: [],
                aircraft_types: [],
              })
              .select()
              .single();

            if (pilot) {
              const items = getItemsForRole(role);
              const rows = items.map((item) => ({
                pilot_profile_id: pilot.id,
                item_key: item.key,
                item_label: item.label,
                required_for: item.required_for,
              }));
              if (rows.length > 0) {
                await supa.from("pilot_onboarding_items").insert(rows);
              }
            }
          }
        }
      } catch (err) {
        console.error("[jobs/stage] Failed to auto-create pilot profile:", err);
      }
    }

    return NextResponse.json({ ok: true, stage, emailResult, interestCheckSent });
  } catch (err) {
    console.error("[jobs/stage] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
