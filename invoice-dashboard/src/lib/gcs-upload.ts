import "server-only";
import { getStorage } from "@/lib/gcs";

/** Map file extension to MIME type for uploads */
export function contentTypeForExt(ext: string | undefined): string {
  switch (ext) {
    case "mp4": return "video/mp4";
    case "m4v": return "video/x-m4v";
    case "mov": return "video/quicktime";
    case "pdf": return "application/pdf";
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

/** @deprecated Use getStorage() from @/lib/gcs directly */
export function getGcsStorage() {
  const storage = getStorage();
  if (!storage) throw new Error("GCS credentials unavailable");
  return storage;
}

/** Generate a presigned upload URL for a file */
export async function presignUpload(
  filename: string,
  gcsPrefix: string,
): Promise<{ bucket: string; key: string; url: string; contentType: string }> {
  const storage = getStorage();
  if (!storage) throw new Error("GCS credentials unavailable");
  const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
  const safeName = filename.replace(/\//g, "_");
  const key = `${gcsPrefix}/${Date.now()}-${safeName}`;
  const ext = filename.split(".").pop()?.toLowerCase();
  const contentType = contentTypeForExt(ext);

  const [url] = await storage.bucket(bucket).file(key).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 30 * 60 * 1000, // 30 minutes
    contentType,
  });
  return { bucket, key, url, contentType };
}
