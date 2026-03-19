import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { presignUpload } from "@/lib/gcs-upload";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const entityType = req.nextUrl.searchParams.get("entity_type");
  const entityId = req.nextUrl.searchParams.get("entity_id");
  const docType = req.nextUrl.searchParams.get("document_type");

  const supa = createServiceClient();
  let q = supa
    .from("intl_documents")
    .select("*")
    .eq("is_current", true)
    .order("created_at", { ascending: false });

  if (entityType) q = q.eq("entity_type", entityType);
  if (entityId) q = q.eq("entity_id", entityId);
  if (docType) q = q.eq("document_type", docType);

  const { data, error } = await q;
  if (error) {
    console.error("[intl/documents] list error:", error);
    return NextResponse.json({ error: "Failed to list documents" }, { status: 500 });
  }
  return NextResponse.json({ documents: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (input.name as string)?.trim();
  const document_type = input.document_type as string;
  const entity_type = input.entity_type as string;
  const entity_id = (input.entity_id as string)?.trim();
  const filename = (input.filename as string)?.trim();
  const content_type = (input.content_type as string) || "application/pdf";

  if (!name || !document_type || !entity_type || !entity_id || !filename) {
    return NextResponse.json({ error: "name, document_type, entity_type, entity_id, filename required" }, { status: 400 });
  }

  const validDocTypes = ["airworthiness", "medical", "certificate", "passport", "insurance", "other"];
  if (!validDocTypes.includes(document_type)) {
    return NextResponse.json({ error: `document_type must be one of: ${validDocTypes.join(", ")}` }, { status: 400 });
  }
  if (!["aircraft", "crew", "company"].includes(entity_type)) {
    return NextResponse.json({ error: "entity_type must be aircraft, crew, or company" }, { status: 400 });
  }

  // Generate presigned upload URL
  const gcsPrefix = `intl-docs/${entity_type}/${entity_id}`;

  let upload: { bucket: string; key: string; url: string; contentType: string };
  try {
    upload = await presignUpload(filename, gcsPrefix);
  } catch (err) {
    console.error("[intl/documents] presign error:", err);
    return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
  }

  // Insert document record
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_documents")
    .insert({
      name,
      document_type,
      entity_type,
      entity_id,
      gcs_bucket: upload.bucket,
      gcs_key: upload.key,
      filename,
      content_type: upload.contentType,
      expiration_date: input.expiration_date ?? null,
      created_by: auth.userId,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[intl/documents] insert error:", error);
    return NextResponse.json({ error: "Failed to create document" }, { status: 500 });
  }
  return NextResponse.json({ document: data, upload_url: upload.url }, { status: 201 });
}
