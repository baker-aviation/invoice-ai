import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

// Simple IP-based rate limiter for public endpoint
const ipHits = new Map<string, number[]>();

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const max = 30;
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < window);
  if (hits.length >= max) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return false;
}

function getIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// ── GET: load form config + candidate name for a token ──────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (isIpRateLimited(getIp(req))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { token } = await params;
  if (!token || token.length < 10 || token.length > 50) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  const sb = getServiceClient();

  // Look up token
  const { data: tokenRow } = await sb
    .from("info_session_tokens")
    .select("parse_id, used_at, expires_at, form_type")
    .eq("token", token)
    .maybeSingle();

  if (!tokenRow) {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });
  }

  if (tokenRow.used_at) {
    return NextResponse.json({ already_submitted: true });
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return NextResponse.json({ error: "This link has expired" }, { status: 410 });
  }

  // Fetch active form matching the token's form_type
  const formSlug = tokenRow.form_type ?? "regular";
  let formQuery = sb
    .from("info_session_forms")
    .select("title, description, questions")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);
  formQuery = formQuery.eq("slug", formSlug);

  const { data: form } = await formQuery.maybeSingle();

  if (!form) {
    return NextResponse.json({ error: "No form configured" }, { status: 500 });
  }

  // Fetch candidate name + rejection status
  const { data: candidate } = await sb
    .from("job_application_parse")
    .select("candidate_name, rejected_at")
    .eq("id", tokenRow.parse_id)
    .maybeSingle();

  if (candidate?.rejected_at) {
    return NextResponse.json({ error: "This link is no longer active" }, { status: 410 });
  }

  return NextResponse.json({
    form: {
      title: form.title,
      description: form.description,
      questions: form.questions,
    },
    candidate_name: candidate?.candidate_name?.split(" ")[0] ?? null,
  });
}

// ── POST: submit form answers ───────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (isIpRateLimited(getIp(req))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { token } = await params;
  if (!token || token.length < 10 || token.length > 50) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  const sb = getServiceClient();

  // Validate token
  const { data: tokenRow } = await sb
    .from("info_session_tokens")
    .select("id, parse_id, used_at, expires_at, form_type")
    .eq("token", token)
    .maybeSingle();

  if (!tokenRow) {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });
  }

  if (tokenRow.used_at) {
    return NextResponse.json({ error: "This form has already been submitted" }, { status: 400 });
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return NextResponse.json({ error: "This link has expired" }, { status: 410 });
  }

  // Check if candidate was rejected
  const { data: candidate } = await sb
    .from("job_application_parse")
    .select("rejected_at")
    .eq("id", tokenRow.parse_id)
    .maybeSingle();

  if (candidate?.rejected_at) {
    return NextResponse.json({ error: "This link is no longer active" }, { status: 410 });
  }

  // Parse body
  let body: { answers?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { answers } = body;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return NextResponse.json({ error: "Answers object is required" }, { status: 400 });
  }

  // Validate answers against form questions
  const formSlug = tokenRow.form_type ?? "regular";
  let formQuery = sb
    .from("info_session_forms")
    .select("questions")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);
  formQuery = formQuery.eq("slug", formSlug);
  const { data: form } = await formQuery.maybeSingle();

  if (form?.questions) {
    const questions = form.questions as Array<{ id: string; required: boolean }>;
    for (const q of questions) {
      if (q.required && (!answers[q.id] || String(answers[q.id]).trim() === "")) {
        return NextResponse.json(
          { error: `"${q.id}" is required` },
          { status: 400 },
        );
      }
    }
  }

  // Save answers to candidate profile
  const { error: updateErr } = await sb
    .from("job_application_parse")
    .update({
      info_session_data: answers,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.parse_id);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Mark token as used
  await sb
    .from("info_session_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return NextResponse.json({ ok: true });
}
