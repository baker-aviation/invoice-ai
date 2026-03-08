import "server-only";

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

/** Create a GCS Storage client */
export async function getGcsStorage() {
  const { Storage } = await import("@google-cloud/storage");
  const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (b64Key) {
    const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
    return new Storage({ credentials: creds, projectId: creds.project_id });
  }
  return new Storage();
}

/** Generate a presigned upload URL for a file */
export async function presignUpload(
  filename: string,
  gcsPrefix: string,
): Promise<{ bucket: string; key: string; url: string; contentType: string }> {
  const storage = await getGcsStorage();
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
