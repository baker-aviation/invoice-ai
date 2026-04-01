import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

// Simple rate limiting
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const max = 30;
  const list = (hits.get(ip) ?? []).filter((t) => now - t < window);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

function htmlPage(title: string, message: string, success: boolean): NextResponse {
  const color = success ? "#059669" : "#dc2626";
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f9fafb;min-height:100vh;display:flex;align-items:center;justify-content:center;">
  <div style="max-width:480px;margin:40px auto;padding:40px;background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">${success ? "✅" : "⚠️"}</div>
    <h1 style="font-size:22px;color:${color};margin:0 0 12px;">${title}</h1>
    <p style="font-size:15px;color:#666;line-height:1.6;margin:0;">${message}</p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /api/public/interest/[token]?response=yes|no
 * Handles email click for "Still interested?" follow-up.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return htmlPage("Too Many Requests", "Please wait a moment and try again.", false);
  }

  const { token } = await params;
  if (!token || token.length < 10 || token.length > 50) {
    return htmlPage("Invalid Link", "This link appears to be malformed.", false);
  }

  const response = req.nextUrl.searchParams.get("response");
  if (response !== "yes" && response !== "no") {
    return htmlPage("Invalid Response", "This link is missing a valid response parameter.", false);
  }

  const sb = getServiceClient();

  const { data: row, error } = await sb
    .from("interest_check_tokens")
    .select("id, parse_id, response, responded_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error || !row) {
    return htmlPage("Link Not Found", "This link is invalid or has expired.", false);
  }

  if (row.responded_at) {
    const prev = row.response === "yes" ? "interested" : "not interested";
    return htmlPage("Already Responded", `You've already indicated that you are <strong>${prev}</strong>. No further action is needed.`, true);
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return htmlPage("Link Expired", "This link has expired. Please contact us if you're still interested.", false);
  }

  const now = new Date().toISOString();

  // Update the token
  await sb
    .from("interest_check_tokens")
    .update({ response, responded_at: now })
    .eq("id", row.id);

  // Update the application
  const updates: Record<string, any> = {
    interest_check_response: response,
    updated_at: now,
  };

  if (response === "yes") {
    updates.pipeline_stage = "tims_review";
  }

  await sb
    .from("job_application_parse")
    .update(updates)
    .eq("id", row.parse_id);

  if (response === "yes") {
    return htmlPage(
      "Thank You!",
      "We're glad you're still interested! Your application has been moved forward in our process. We'll be in touch soon.",
      true,
    );
  } else {
    return htmlPage(
      "Thank You",
      "We appreciate you letting us know. If you change your mind in the future, don't hesitate to reach out. We wish you the best!",
      true,
    );
  }
}
