import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect } from "next/navigation";
import Link from "next/link";
import BulletinDetail from "./BulletinDetail";

export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
};

const CATEGORY_COLORS: Record<string, string> = {
  chief_pilot: "bg-blue-100 text-blue-800",
  operations: "bg-green-100 text-green-800",
  tims: "bg-purple-100 text-purple-800",
  maintenance: "bg-orange-100 text-orange-800",
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
    .select("*")
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

  const downloadUrl = bulletin.pdf_gcs_key
    ? `/api/pilot/bulletins/${bulletin.id}/download`
    : null;

  return (
    <div>
      <Link
        href="/pilot/bulletins"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        &larr; Back to Bulletins
      </Link>

      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full ${categoryColor}`}
          >
            {categoryLabel}
          </span>
          <span className="text-xs text-gray-400">{publishedAt}</span>
        </div>

        <h1 className="text-lg font-bold text-gray-900 mb-3">{bulletin.title}</h1>

        {bulletin.summary && (
          <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
            {bulletin.summary}
          </p>
        )}

        <BulletinDetail
          bulletinId={bulletin.id}
          downloadUrl={downloadUrl}
          pdfFilename={bulletin.pdf_filename}
          videoUrl={bulletin.video_url}
        />
      </div>
    </div>
  );
}
