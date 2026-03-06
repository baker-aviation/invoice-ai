import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { redirect } from "next/navigation";
import Link from "next/link";
import BulletinDetail from "./BulletinDetail";

export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
  citation_x: "Citation X",
  challenger_300: "Challenger 300",
};

const CATEGORY_COLORS: Record<string, string> = {
  chief_pilot: "bg-blue-100 text-blue-800",
  operations: "bg-green-100 text-green-800",
  tims: "bg-purple-100 text-purple-800",
  maintenance: "bg-orange-100 text-orange-800",
  citation_x: "bg-sky-100 text-sky-800",
  challenger_300: "bg-amber-100 text-amber-800",
};

type SignedAttachment = {
  id: number;
  filename: string;
  content_type: string;
  url: string | null;
};

export default async function BulletinDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const role = user.app_metadata?.role ?? user.user_metadata?.role;
  if (role !== "pilot" && role !== "admin") redirect("/");

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) redirect("/pilot/bulletins");

  const supa = createServiceClient();
  const { data: bulletin } = await supa
    .from("pilot_bulletins")
    .select("*, pilot_bulletin_attachments(id, filename, content_type, gcs_bucket, gcs_key, sort_order)")
    .eq("id", bulletinId)
    .single();

  if (!bulletin) redirect("/pilot/bulletins");

  const categoryLabel = CATEGORY_LABELS[bulletin.category] || bulletin.category;
  const categoryColor = CATEGORY_COLORS[bulletin.category] || "bg-gray-100 text-gray-700";
  const publishedAt = new Date(bulletin.published_at).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const isAdmin = role === "admin";

  // Sign URLs for all attachments
  const rawAttachments = (bulletin.pilot_bulletin_attachments ?? []) as {
    id: number;
    filename: string;
    content_type: string;
    gcs_bucket: string;
    gcs_key: string;
    sort_order: number;
  }[];
  const attachments: SignedAttachment[] = await Promise.all(
    rawAttachments
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(async (a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        url: await signGcsUrl(a.gcs_bucket, a.gcs_key),
      })),
  );

  return (
    <div>
      <Link
        href="/pilot/bulletins"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        &larr; Back to Bulletins
      </Link>

      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full ${categoryColor}`}
            >
              {categoryLabel}
            </span>
            <span className="text-xs text-gray-400">{publishedAt}</span>
          </div>
          {isAdmin && (
            <BulletinDetail
              bulletinId={bulletin.id}
              slackTs={bulletin.slack_ts}
              title={bulletin.title}
              summary={bulletin.summary ?? ""}
              category={bulletin.category}
              attachments={attachments.map((a) => ({ id: a.id, filename: a.filename }))}
            />
          )}
        </div>

        <h1 className="text-lg font-bold text-gray-900 mb-3">{bulletin.title}</h1>

        {bulletin.summary && (
          <div
            className="text-sm text-gray-700 mb-4 leading-relaxed prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-headings:my-2 [&>div]:my-0.5 [&_*]:!text-sm [&_*]:!text-gray-700 [&_h1]:!text-base [&_h1]:!font-bold [&_h2]:!text-sm [&_h2]:!font-bold [&_h3]:!text-sm [&_h3]:!font-semibold [&_b]:!font-semibold [&_strong]:!font-semibold"
            dangerouslySetInnerHTML={{ __html: bulletin.summary }}
          />
        )}

        {/* Render all attachments */}
        {attachments.map((att) => {
          const isVideo = att.content_type.startsWith("video/");
          const isImage = att.content_type.startsWith("image/");
          const downloadUrl = att.url ?? `/api/pilot/bulletins/${bulletin.id}/download?attachment_id=${att.id}`;

          if (isVideo) {
            return (
              <div key={att.id} className="border rounded-lg overflow-hidden mt-4">
                <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm bg-gray-50">
                  <div className="font-medium truncate">{att.filename}</div>
                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-100 font-medium text-blue-600 shrink-0"
                  >
                    Download
                  </a>
                </div>
                <div className="border-t bg-black aspect-video relative">
                  <video
                    src={downloadUrl}
                    controls
                    className="w-full h-full"
                    preload="metadata"
                  >
                    Your browser does not support video playback.
                  </video>
                  {!att.url && (
                    <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
                      <p className="text-sm text-gray-300">
                        Video preview unavailable.{" "}
                        <a
                          href={`/api/pilot/bulletins/${bulletin.id}/download?attachment_id=${att.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-400 underline"
                        >
                          Download to watch
                        </a>
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={att.id} className="border rounded-lg overflow-hidden mt-4">
              <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm bg-gray-50">
                <div className="font-medium truncate">{att.filename}</div>
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-100 font-medium text-blue-600 shrink-0"
                >
                  {isImage ? "Open" : "Download"}
                </a>
              </div>
              {isImage && att.url ? (
                <div className="border-t bg-gray-100 p-4 flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={att.url}
                    alt={att.filename}
                    className="max-w-full max-h-[600px] rounded"
                  />
                </div>
              ) : att.url ? (
                <div className="border-t">
                  <iframe
                    src={att.url}
                    className="w-full h-[600px]"
                    title={att.filename}
                  />
                </div>
              ) : (
                <div className="border-t bg-gray-50 p-6 text-center">
                  <p className="text-sm text-gray-500">
                    Preview unavailable.{" "}
                    <a
                      href={`/api/pilot/bulletins/${bulletin.id}/download?attachment_id=${att.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-500 underline"
                    >
                      Download to view
                    </a>
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
