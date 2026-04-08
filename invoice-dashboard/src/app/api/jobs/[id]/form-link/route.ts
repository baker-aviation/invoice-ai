import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { requireAdmin, isAuthed } from "@/lib/api-auth";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const parseId = Number(id);
  if (!parseId || isNaN(parseId)) {
    return NextResponse.json({ error: "Invalid candidate ID" }, { status: 400 });
  }

  let formType = "regular";
  try {
    const body = await req.json();
    if (body.form_type && typeof body.form_type === "string") {
      formType = body.form_type;
    }
  } catch {
    // No body or invalid JSON — use default
  }

  const sb = getServiceClient();

  // Verify candidate exists and isn't rejected
  const { data: candidate } = await sb
    .from("job_application_parse")
    .select("id, candidate_name, rejected_at")
    .eq("id", parseId)
    .maybeSingle();

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  if (candidate.rejected_at) {
    return NextResponse.json({ error: "Cannot generate form link for a rejected candidate" }, { status: 400 });
  }

  // Check for existing unused token of same form type
  const { data: existing } = await sb
    .from("info_session_tokens")
    .select("token, used_at, expires_at")
    .eq("parse_id", parseId)
    .eq("form_type", formType)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const baseUrl = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
    const protocol = req.headers.get("x-forwarded-proto") || "https";
    return NextResponse.json({
      url: `${protocol}://${baseUrl}/form/${existing.token}`,
      token: existing.token,
      existing: true,
    });
  }

  // Generate new token
  const token = randomBytes(18).toString("base64url");

  const { error } = await sb.from("info_session_tokens").insert({
    token,
    parse_id: parseId,
    form_type: formType,
    created_by: auth.email || auth.userId,
  });

  if (error) {
    return NextResponse.json({ error: "Failed to create form link" }, { status: 500 });
  }

  const baseUrl = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const protocol = req.headers.get("x-forwarded-proto") || "https";

  return NextResponse.json({
    url: `${protocol}://${baseUrl}/form/${token}`,
    token,
    existing: false,
  }, { status: 201 });
}
