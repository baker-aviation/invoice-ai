import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/jobs/templates?role=pic
 * Fetch all offer templates, optionally filtered by role.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const role = req.nextUrl.searchParams.get("role");
  const supa = createServiceClient();

  let query = supa.from("offer_templates").select("*").order("role");
  if (role) {
    query = query.eq("role", role);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ templates: data ?? [] });
}

/**
 * PUT /api/jobs/templates
 * Upsert a template by role. Body: { role, html_body }
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { role?: string; html_body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { role, html_body } = body;
  if (!role || !html_body) {
    return NextResponse.json({ error: "role and html_body are required" }, { status: 400 });
  }

  if (role !== "pic" && role !== "sic") {
    return NextResponse.json({ error: "role must be 'pic' or 'sic'" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("offer_templates")
    .upsert(
      {
        role,
        name: role.toUpperCase() + " Offer Letter",
        html_body,
        updated_at: new Date().toISOString(),
        updated_by: auth.email,
      },
      { onConflict: "role" },
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, template: data });
}
