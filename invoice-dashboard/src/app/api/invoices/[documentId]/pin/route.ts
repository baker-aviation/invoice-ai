import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

type Params = { params: Promise<{ documentId: string }> };

/**
 * POST /api/invoices/[documentId]/pin — Pin an invoice for review
 * Body: { note: string }
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  let note = "";
  try {
    const body = await req.json();
    note = typeof body.note === "string" ? body.note.slice(0, 2000) : "";
  } catch {
    // No body is ok — pin without note
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("parsed_invoices")
    .update({
      pinned: true,
      pin_note: note || null,
      pinned_by: auth.userId,
      pinned_at: new Date().toISOString(),
      pin_resolved: false,
      resolved_by: null,
      resolved_at: null,
    })
    .eq("document_id", documentId);

  if (error) {
    console.error("[pin] error:", error);
    return NextResponse.json({ error: "Failed to pin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, pinned: true });
}

/**
 * PATCH /api/invoices/[documentId]/pin — Update pin note
 * Body: { note: string }
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  let note = "";
  try {
    const body = await req.json();
    note = typeof body.note === "string" ? body.note.slice(0, 2000) : "";
  } catch {
    return NextResponse.json({ error: "Missing note" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("parsed_invoices")
    .update({ pin_note: note || null })
    .eq("document_id", documentId)
    .eq("pinned", true);

  if (error) {
    console.error("[pin] update error:", error);
    return NextResponse.json({ error: "Failed to update note" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/invoices/[documentId]/pin — Resolve a pin
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("parsed_invoices")
    .update({
      pin_resolved: true,
      resolved_by: auth.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("document_id", documentId)
    .eq("pinned", true);

  if (error) {
    console.error("[pin] resolve error:", error);
    return NextResponse.json({ error: "Failed to resolve" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, resolved: true });
}
