import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

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

  const supa = createServiceClient();
  const safeName = file.name.replace(/\//g, "_");
  const path = `requirement-attachments/${id}/${Date.now()}-${safeName}`;
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    // Upload to Supabase Storage (service role bypasses RLS)
    const { error: uploadErr } = await supa.storage
      .from("intl-docs")
      .upload(path, buf, { contentType: file.type || "application/octet-stream", upsert: true });

    if (uploadErr) {
      // Bucket may not exist — create it and retry
      if (uploadErr.message?.includes("not found") || uploadErr.statusCode === "404") {
        await supa.storage.createBucket("intl-docs", { public: true });
        const { error: retryErr } = await supa.storage
          .from("intl-docs")
          .upload(path, buf, { contentType: file.type || "application/octet-stream", upsert: true });
        if (retryErr) throw retryErr;
      } else {
        throw uploadErr;
      }
    }

    const { data: urlData } = supa.storage.from("intl-docs").getPublicUrl(path);

    // Update requirement record
    const { data, error } = await supa
      .from("country_requirements")
      .update({
        attachment_url: urlData.publicUrl,
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
