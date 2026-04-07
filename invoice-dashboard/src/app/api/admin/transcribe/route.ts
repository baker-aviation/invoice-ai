import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { getGcsStorage } from "@/lib/gcs-upload";
import OpenAI from "openai";

export const maxDuration = 300; // 5 minutes — transcription can be slow

/**
 * POST /api/admin/transcribe
 * Body: { gcsKeys: string[] }
 * Downloads audio chunks from GCS, sends each to Whisper, returns combined transcript.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY not configured" },
      { status: 500 },
    );
  }

  const body = await req.json();
  const gcsKeys: string[] = body.gcsKeys;
  if (!gcsKeys?.length) {
    return NextResponse.json(
      { error: "gcsKeys array is required" },
      { status: 400 },
    );
  }

  try {
    const storage = await getGcsStorage();
    const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
    const openai = new OpenAI({ apiKey });

    const transcripts: string[] = [];

    for (const key of gcsKeys) {
      // Download chunk from GCS
      const [buffer] = await storage.bucket(bucket).file(key).download();

      // Convert Node Buffer to a Blob-compatible type for File constructor
      const file = new File([buffer as unknown as BlobPart], "audio.wav", { type: "audio/wav" });

      const response = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file,
        response_format: "verbose_json",
      });

      transcripts.push(response.text);
    }

    // Clean up GCS files after transcription
    for (const key of gcsKeys) {
      storage
        .bucket(bucket)
        .file(key)
        .delete()
        .catch(() => {}); // best-effort cleanup
    }

    return NextResponse.json({
      ok: true,
      transcript: transcripts.join("\n\n"),
      chunks: transcripts.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Transcription failed";
    console.error("Transcription error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/admin/transcribe/presign is handled by a separate route segment,
 * but we can also handle it here via a query param for simplicity.
 *
 * GET /api/admin/transcribe?action=presign&filename=chunk_001.wav
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "presign") {
    const filename = searchParams.get("filename") || "audio.wav";
    const { presignUpload } = await import("@/lib/gcs-upload");
    const result = await presignUpload(filename, "transcribe-temp");
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
