import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { getGcsStorage } from "@/lib/gcs-upload";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const maxDuration = 300; // 5 min — large videos take time

/**
 * POST /api/admin/extract-audio
 * Body: { gcsKey: string }
 *
 * Downloads video from GCS, extracts audio via FFmpeg (server-side),
 * splits into ≤20MB WAV chunks, uploads chunks to GCS, returns keys.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { gcsKey } = await req.json();
  if (!gcsKey) {
    return NextResponse.json({ error: "gcsKey is required" }, { status: 400 });
  }

  const workDir = join(tmpdir(), `extract-audio-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  const inputPath = join(workDir, "input");
  const outputPattern = join(workDir, "chunk_%03d.wav");

  try {
    // 1. Download video from GCS
    const storage = await getGcsStorage();
    const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
    const [buffer] = await storage.bucket(bucket).file(gcsKey).download();
    await writeFile(inputPath, buffer);

    // 2. Get audio duration to calculate chunk split points
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegPath = require("ffmpeg-static") as string;

    // Use segment muxer to split into ~20MB chunks (16kHz mono 16-bit = 32KB/s → ~625s per 20MB)
    const segmentDuration = 625; // seconds per chunk

    await execFileAsync(ffmpegPath, [
      "-i", inputPath,
      "-vn",                    // no video
      "-ar", "16000",           // 16kHz (Whisper requirement)
      "-ac", "1",               // mono
      "-c:a", "pcm_s16le",      // 16-bit PCM WAV
      "-f", "segment",
      "-segment_time", String(segmentDuration),
      outputPattern,
    ], { maxBuffer: 10 * 1024 * 1024 });

    // 3. Find output chunks and upload to GCS
    const { readdir } = await import("fs/promises");
    const files = (await readdir(workDir))
      .filter((f) => f.startsWith("chunk_") && f.endsWith(".wav"))
      .sort();

    const gcsKeys: string[] = [];
    for (const file of files) {
      const chunkPath = join(workDir, file);
      const chunkBuffer = await readFile(chunkPath);

      const key = `transcribe-temp/${Date.now()}-${file}`;
      await storage.bucket(bucket).file(key).save(chunkBuffer, {
        contentType: "audio/wav",
      });
      gcsKeys.push(key);
    }

    return NextResponse.json({ ok: true, gcsKeys, chunks: gcsKeys.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Audio extraction failed";
    console.error("extract-audio error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    // Clean up temp files
    const { readdir } = await import("fs/promises");
    try {
      const files = await readdir(workDir);
      await Promise.all(files.map((f) => unlink(join(workDir, f)).catch(() => {})));
      const { rmdir } = await import("fs/promises");
      await rmdir(workDir).catch(() => {});
    } catch { /* best-effort */ }

    // Clean up source video from GCS
    try {
      const storage = await getGcsStorage();
      const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      await storage.bucket(bucket).file(gcsKey).delete();
    } catch { /* best-effort */ }
  }
}
