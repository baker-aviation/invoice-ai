import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";
import archiver from "archiver";
import { PassThrough } from "stream";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/ops/intl/trip-docs?tail=N954JS&dep=MWCR&arr=KHPN
 *
 * Downloads a ZIP containing all relevant documents for a trip:
 *   - Aircraft docs (airworthiness, registration, noise cert, insurance)
 *   - Company docs (OpSpecs, CBP forms, overflight exemptions, etc.)
 *
 * The ZIP is organized into folders:
 *   /Aircraft - N954JS/
 *   /Company/
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tail = req.nextUrl.searchParams.get("tail")?.toUpperCase();
  if (!tail) {
    return NextResponse.json({ error: "tail parameter required" }, { status: 400 });
  }

  const dep = req.nextUrl.searchParams.get("dep")?.toUpperCase() ?? "";
  const arr = req.nextUrl.searchParams.get("arr")?.toUpperCase() ?? "";

  const supa = createServiceClient();

  // Fetch aircraft docs + company docs in parallel
  const [aircraftRes, companyRes] = await Promise.all([
    supa
      .from("intl_documents")
      .select("id, name, gcs_bucket, gcs_key, filename")
      .eq("entity_type", "aircraft")
      .eq("entity_id", tail)
      .eq("is_current", true),
    supa
      .from("intl_documents")
      .select("id, name, gcs_bucket, gcs_key, filename")
      .eq("entity_type", "company")
      .eq("entity_id", "baker_aviation")
      .eq("is_current", true),
  ]);

  const aircraftDocs = aircraftRes.data ?? [];
  const companyDocs = companyRes.data ?? [];

  if (aircraftDocs.length === 0 && companyDocs.length === 0) {
    return NextResponse.json({ error: "No documents found" }, { status: 404 });
  }

  const storage = await getGcsStorage();

  // Create ZIP archive
  const archive = archiver("zip", { zlib: { level: 5 } });
  const passthrough = new PassThrough();
  archive.pipe(passthrough);

  // Add aircraft documents
  for (const doc of aircraftDocs) {
    try {
      const bucket = storage.bucket(doc.gcs_bucket);
      const file = bucket.file(doc.gcs_key);
      const [exists] = await file.exists();
      if (!exists) continue;
      const stream = file.createReadStream();
      const ext = doc.filename?.endsWith(".pdf") ? "" : ".pdf";
      archive.append(stream, { name: `Aircraft - ${tail}/${doc.name}${ext}` });
    } catch {
      // Skip files that can't be read
    }
  }

  // Add company documents
  for (const doc of companyDocs) {
    try {
      const bucket = storage.bucket(doc.gcs_bucket);
      const file = bucket.file(doc.gcs_key);
      const [exists] = await file.exists();
      if (!exists) continue;
      const stream = file.createReadStream();
      const ext = doc.filename?.endsWith(".pdf") ? "" : ".pdf";
      archive.append(stream, { name: `Company/${doc.name}${ext}` });
    } catch {
      // Skip files that can't be read
    }
  }

  archive.finalize();

  const zipName = `${tail}_${dep}-${arr}_trip-docs.zip`;

  // Convert PassThrough to ReadableStream for Next.js response
  const readable = new ReadableStream({
    start(controller) {
      passthrough.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      passthrough.on("end", () => controller.close());
      passthrough.on("error", (err) => controller.error(err));
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
    },
  });
}
