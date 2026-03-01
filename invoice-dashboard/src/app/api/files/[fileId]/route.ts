import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

const JOB_BASE = process.env.JOB_API_BASE_URL;

const SAFE_ID_RE = /^[0-9]{1,20}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { fileId } = await params;
  if (!SAFE_ID_RE.test(fileId)) {
    return NextResponse.json({ error: "Invalid file ID" }, { status: 400 });
  }

  // Strategy 1: Direct GCS signing via service account key
  const supa = createServiceClient();
  const { data: file } = await supa
    .from("job_application_files")
    .select("gcs_bucket, gcs_key, content_type, filename")
    .eq("id", Number(fileId))
    .maybeSingle();

  if (file?.gcs_bucket && file?.gcs_key) {
    const signed = await signGcsUrl(file.gcs_bucket, file.gcs_key, 120);
    if (signed) {
      return NextResponse.redirect(signed, 302);
    }
  }

  // Strategy 2: Cloud Run proxy
  if (JOB_BASE) {
    const base = JOB_BASE.replace(/\/$/, "");
    const url = `${base}/api/files/${encodeURIComponent(fileId)}`;

    const res = await cloudRunFetch(url, { redirect: "manual", cache: "no-store" });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (location.startsWith("https://storage.googleapis.com/")) {
        return NextResponse.redirect(location, 302);
      }
    }
  }

  return NextResponse.json({ error: "File unavailable — no GCS credentials or backend configured" }, { status: 503 });
}
