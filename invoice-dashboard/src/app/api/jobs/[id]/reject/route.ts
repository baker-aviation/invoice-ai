import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const REJECTION_TYPES = ["hard", "soft", "left_process"] as const;
type RejectionType = (typeof REJECTION_TYPES)[number];

const TEMPLATE_KEYS: Record<RejectionType, string> = {
  hard: "rejection_email_hard",
  soft: "rejection_email_soft",
  left_process: "rejection_email_left",
};

const SUBJECT_LINES: Record<RejectionType, string> = {
  hard: "Baker Aviation — Application Update",
  soft: "Baker Aviation — Application Update",
  left_process: "Baker Aviation — Following Up",
};

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
  if (!res.ok) throw new Error(`MS Graph token failed: ${res.status}`);
  return (await res.json()).access_token;
}

function buildHtmlEmail(bodyText: string, logoUrl: string): string {
  // Convert newlines to <br> for HTML
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
 * POST /api/jobs/[id]/reject
 * Body: { rejection_type: "hard"|"soft"|"left_process", rejection_reason?: string, send_email?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {}

  const rejectionType = body.rejection_type as string;
  if (!rejectionType || !REJECTION_TYPES.includes(rejectionType as RejectionType)) {
    // Legacy support: if no type specified, default to "hard"
    // (for the old reject button that doesn't send a type)
  }

  const type: RejectionType = REJECTION_TYPES.includes(rejectionType as RejectionType)
    ? (rejectionType as RejectionType)
    : "hard";
  const reason = typeof body.rejection_reason === "string" ? body.rejection_reason : null;
  const emailNotes = typeof body.email_notes === "string" ? body.email_notes : null;
  const sendEmail = body.send_email !== false; // default true

  const supa = createServiceClient();

  // Fetch candidate info for email
  const { data: job } = await supa
    .from("job_application_parse")
    .select("id, candidate_name, email, pipeline_stage")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  // Update rejection fields + clear pipeline stage
  const { error: updateErr } = await supa
    .from("job_application_parse")
    .update({
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
      rejection_type: type,
      rejected_by: auth.email || auth.userId,
      pipeline_stage: "",
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", applicationId);

  if (updateErr) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  // Invalidate any active form tokens so rejected candidates can't access forms
  await supa
    .from("info_session_tokens")
    .delete()
    .eq("parse_id", job.id)
    .is("used_at", null);

  // Send rejection email
  let emailSent = false;
  let emailError: string | null = null;

  if (sendEmail && job.email) {
    try {
      // Get email template from settings
      const templateKey = TEMPLATE_KEYS[type];
      const { data: setting } = await supa
        .from("hiring_settings")
        .select("value")
        .eq("key", templateKey)
        .maybeSingle();

      if (!setting?.value) {
        emailError = `Email template "${templateKey}" not configured. Go to Jobs → Admin.`;
      } else {
        // Replace {{name}} with candidate's first name, {{notes}} with email notes
        const firstName = (job.candidate_name ?? "").split(/\s+/)[0] || "Applicant";
        let emailText = setting.value.replace(/\{\{name\}\}/g, firstName);

        if (type === "soft" && emailNotes) {
          if (emailText.includes("{{notes}}")) {
            emailText = emailText.replace(/\{\{notes\}\}/g, emailNotes);
          } else {
            // Append notes before the sign-off (last paragraph)
            const lines = emailText.split("\n");
            const insertIdx = Math.max(lines.length - 2, 1);
            lines.splice(insertIdx, 0, "", emailNotes);
            emailText = lines.join("\n");
          }
        } else {
          // Remove {{notes}} placeholder if no notes provided
          emailText = emailText.replace(/\{\{notes\}\}/g, "");
        }

        const token = await getGraphToken();
        const mailbox = process.env.OUTLOOK_HR_MAILBOX || "HR@baker-aviation.com";

        // Build logo URL from the request origin
        const origin = req.headers.get("origin") || req.headers.get("referer")?.replace(/\/[^/]*$/, "") || "https://baker-ai-gamma.vercel.app";
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
                subject: SUBJECT_LINES[type],
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

        if (sendRes.ok) {
          emailSent = true;
        } else {
          const errText = await sendRes.text();
          console.error("[reject] Graph sendMail failed:", sendRes.status, errText);
          emailError = `Email send failed (HTTP ${sendRes.status})`;
        }
      }
    } catch (err) {
      console.error("[reject] Email error:", err);
      emailError = String(err);
    }
  }

  return NextResponse.json({
    ok: true,
    rejectionType: type,
    emailSent,
    emailError,
    candidateEmail: job.email,
  });
}

/**
 * DELETE /api/jobs/[id]/reject — un-reject (clear rejection)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("job_application_parse")
    .update({
      rejected_at: null,
      rejection_reason: null,
      rejection_type: null,
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", applicationId);

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
