import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

/**
 * PUT /api/admin/pilot-documents/[id] — update document metadata
 * DELETE /api/admin/pilot-documents/[id] — delete document + GCS file
 */

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const body = await req.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.category !== undefined) updates.category = body.category;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_documents")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[pilot-documents] update error:", error);
    return NextResponse.json({ error: "Failed to update document" }, { status: 500 });
  }

  return NextResponse.json({ document: data });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const supa = createServiceClient();

  // Fetch doc to get GCS info
  const { data: doc, error: fetchErr } = await supa
    .from("pilot_documents")
    .select("gcs_bucket, gcs_key")
    .eq("id", id)
    .single();

  if (fetchErr || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Delete from GCS
  try {
    const { Storage } = await import("@google-cloud/storage");
    let storage: InstanceType<typeof Storage>;
    const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (b64Key) {
      const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
      storage = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storage = new Storage();
    }
    await storage.bucket(doc.gcs_bucket).file(doc.gcs_key).delete({ ignoreNotFound: true });
  } catch (err) {
    console.warn("[pilot-documents] GCS delete failed (continuing):", err);
  }

  // Delete DB row
  const { error: delErr } = await supa
    .from("pilot_documents")
    .delete()
    .eq("id", id);

  if (delErr) {
    console.error("[pilot-documents] delete error:", delErr);
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
