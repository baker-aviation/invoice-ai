import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/meetings/[id]/tickets
 * List all tickets for a meeting.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("meeting_tickets")
    .select("*")
    .eq("meeting_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ tickets: data || [] });
}

/**
 * PATCH /api/admin/meetings/[id]/tickets
 * Update a ticket: accept/reject, edit, push to admin_tickets.
 * Body: { ticket_id, ...updates }
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const body = await req.json();
  const { ticket_id, action, ...updates } = body;

  if (!ticket_id) {
    return NextResponse.json({ error: "ticket_id is required" }, { status: 400 });
  }

  const sb = createServiceClient();

  // Special action: accept and push to admin_tickets
  if (action === "accept") {
    // Fetch the meeting ticket
    const { data: ticket, error: ticketErr } = await sb
      .from("meeting_tickets")
      .select("*")
      .eq("id", ticket_id)
      .eq("meeting_id", id)
      .single();

    if (ticketErr || !ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Create an admin_ticket from it
    const priorityMap: Record<string, number> = {
      critical: 10,
      high: 25,
      medium: 50,
      low: 75,
    };

    const { data: adminTicket, error: adminErr } = await sb
      .from("admin_tickets")
      .insert({
        title: ticket.title,
        body: ticket.description,
        priority: priorityMap[ticket.priority] || 50,
        labels: [ticket.ticket_type, "from-meeting"],
        section: "general",
        status: "open",
        created_by: auth.userId,
      })
      .select()
      .single();

    if (adminErr) {
      return NextResponse.json({ error: adminErr.message }, { status: 500 });
    }

    // Update meeting ticket status
    await sb
      .from("meeting_tickets")
      .update({ status: "accepted", admin_ticket_id: adminTicket.id })
      .eq("id", ticket_id);

    return NextResponse.json({ ok: true, admin_ticket: adminTicket });
  }

  // Special action: reject
  if (action === "reject") {
    await sb.from("meeting_tickets").update({ status: "rejected" }).eq("id", ticket_id);
    return NextResponse.json({ ok: true });
  }

  // General update (title, description, priority, ticket_type)
  const allowed: Record<string, unknown> = {};
  for (const key of ["title", "description", "priority", "ticket_type", "assignee_hint", "status"]) {
    if (key in updates) allowed[key] = updates[key];
  }

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await sb
    .from("meeting_tickets")
    .update(allowed)
    .eq("id", ticket_id)
    .eq("meeting_id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket: data });
}

/**
 * DELETE /api/admin/meetings/[id]/tickets?ticket_id=123
 */
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get("ticket_id");

  if (!ticketId) {
    return NextResponse.json({ error: "ticket_id is required" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb
    .from("meeting_tickets")
    .delete()
    .eq("id", ticketId)
    .eq("meeting_id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
