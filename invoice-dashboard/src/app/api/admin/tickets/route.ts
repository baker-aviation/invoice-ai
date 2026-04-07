import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/admin/tickets?status=open
 * List tickets, ordered by priority (ascending = highest first).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // optional filter

  const sb = createServiceClient();
  let query = sb
    .from("admin_tickets")
    .select("*")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ tickets: data });
}

/**
 * POST /api/admin/tickets
 * Create a new ticket.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { title, body: ticketBody, priority, claude_prompt, github_issue, labels } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("admin_tickets")
    .insert({
      title: title.trim(),
      body: ticketBody || null,
      priority: priority ?? 50,
      claude_prompt: claude_prompt || null,
      github_issue: github_issue || null,
      labels: labels || [],
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket: data });
}

/**
 * PATCH /api/admin/tickets
 * Update a ticket. Body must include { id, ...fields }.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Only allow updating known fields
  const allowed: Record<string, unknown> = {};
  for (const key of ["title", "body", "priority", "status", "claude_prompt", "github_issue", "labels"]) {
    if (key in updates) allowed[key] = updates[key];
  }
  allowed.updated_at = new Date().toISOString();

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("admin_tickets")
    .update(allowed)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket: data });
}

/**
 * DELETE /api/admin/tickets?id=123
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb.from("admin_tickets").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
