import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_documents")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Generate signed download URL
  const storage = await getGcsStorage();
  const bucket = storage.bucket(data.gcs_bucket);
  const file = bucket.file(data.gcs_key);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 30 * 60 * 1000, // 30 minutes
  });

  return NextResponse.json({ document: data, download_url: url });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.expiration_date !== undefined) updates.expiration_date = input.expiration_date;
  if (input.is_current !== undefined) updates.is_current = input.is_current;
  if (input.entity_type !== undefined) updates.entity_type = input.entity_type;
  if (input.entity_id !== undefined) updates.entity_id = input.entity_id;
  if (input.document_type !== undefined) updates.document_type = input.document_type;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_documents")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[intl/documents] update error:", error);
    return NextResponse.json({ error: "Failed to update document" }, { status: 500 });
  }
  return NextResponse.json({ document: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  // Soft delete — mark as not current
  const { error } = await supa
    .from("intl_documents")
    .update({ is_current: false, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[intl/documents] delete error:", error);
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
