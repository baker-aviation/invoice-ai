import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

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

// ── GET: load form questions ────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (isIpRateLimited(getIp(req))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const slug = req.nextUrl.searchParams.get("type") ?? "regular";

  const sb = getServiceClient();

  let query = sb
    .from("info_session_forms")
    .select("title, description, questions")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);

  // Filter by slug if the column exists; fall back gracefully
  query = query.eq("slug", slug);

  const { data: form } = await query.maybeSingle();

  if (!form) {
    return NextResponse.json({ error: "No form configured" }, { status: 500 });
  }

  return NextResponse.json({ form });
}

// ── POST: submit form — match candidate by name + email ─────────────────────

export async function POST(req: NextRequest) {
  if (isIpRateLimited(getIp(req))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const slug = req.nextUrl.searchParams.get("type") ?? "regular";

  let body: { name?: string; email?: string; answers?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const { answers } = body;

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return NextResponse.json({ error: "Answers are required" }, { status: 400 });
  }

  const sb = getServiceClient();

  // Validate answers against form questions
  const { data: form } = await sb
    .from("info_session_forms")
    .select("questions")
    .eq("is_active", true)
    .eq("slug", slug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (form?.questions) {
    const questions = form.questions as Array<{ id: string; label: string; required: boolean }>;
    for (const q of questions) {
      if (q.required && (!answers[q.id] || String(answers[q.id]).trim() === "")) {
        return NextResponse.json({ error: `"${q.label}" is required` }, { status: 400 });
      }
    }
  }

  // Try to match candidate by email (most reliable)
  const { data: candidate } = await sb
    .from("job_application_parse")
    .select("id")
    .ilike("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (candidate) {
    // Update existing candidate profile
    await sb
      .from("job_application_parse")
      .update({
        info_session_data: answers,
        updated_at: new Date().toISOString(),
      })
      .eq("id", candidate.id);

    return NextResponse.json({ ok: true, matched: true });
  }

  // No match found — create a new candidate record
  const { data: appRow, error: appErr } = await sb
    .from("job_applications")
    .insert({
      mailbox: "info-session-form",
      role_bucket: "other",
      subject: `Info session form: ${name}`,
      received_at: new Date().toISOString(),
      source_message_id: `info-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    })
    .select("id")
    .single();

  if (appErr || !appRow) {
    return NextResponse.json({ error: "Failed to create profile" }, { status: 500 });
  }

  const { error: parseErr } = await sb
    .from("job_application_parse")
    .insert({
      application_id: appRow.id,
      candidate_name: name,
      email: email,
      info_session_data: answers,
      hiring_stage: "info_session",
      pipeline_stage: "info_session",
      model: "info-session-form",
    });

  if (parseErr) {
    return NextResponse.json({ error: `Failed to save: ${parseErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, matched: false });
}
