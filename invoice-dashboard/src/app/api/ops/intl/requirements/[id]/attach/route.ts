import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage, contentTypeForExt } from "@/lib/gcs-upload";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Upload to GCS
  const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
  const safeName = file.name.replace(/\//g, "_");
  const key = `intl-docs/requirement-attachments/${id}/${Date.now()}-${safeName}`;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const contentType = contentTypeForExt(ext);

  try {
    const storage = await getGcsStorage();
    const buf = Buffer.from(await file.arrayBuffer());
    await storage.bucket(bucket).file(key).save(buf, {
      metadata: { contentType },
    });

    // Make file publicly readable
    await storage.bucket(bucket).file(key).makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket}/${key}`;

    // Update requirement record
    const supa = createServiceClient();
    const { data, error } = await supa
      .from("country_requirements")
      .update({
        attachment_url: publicUrl,
        attachment_filename: file.name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("[intl/requirements/attach] update error:", error);
      return NextResponse.json({ error: "Failed to update requirement" }, { status: 500 });
    }

    return NextResponse.json({ requirement: data });
  } catch (err) {
    console.error("[intl/requirements/attach] upload error:", err);
    return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
  }
}
