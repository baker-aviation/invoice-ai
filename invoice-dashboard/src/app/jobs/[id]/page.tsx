import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { Badge } from "@/components/Badge";
import { fetchJobDetail } from "@/lib/jobApi";
import FileViewer from "./FileViewer";

function fmtDate(s: any) {
  return String(s ?? "").replace("T", " ").replace("+00:00", "Z");
}

function mustJobBase(): string {
  const base = process.env.JOB_API_BASE_URL;
  if (!base) throw new Error("Missing JOB_API_BASE_URL in .env.local");
  return base.replace(/\/$/, "");
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params; // ✅ Next 16: params is a Promise
  const raw = id;
  const applicationId = String(raw ?? "").match(/\d+/)?.[0] || "";

  if (!applicationId) {
    throw new Error(`Invalid id param: ${String(raw)}`);
  }

  try {
    const data = await fetchJobDetail(applicationId);
    const job = data.job;
    const files = data.files ?? [];
    const jobBase = mustJobBase();

    return (
      <>
        <Topbar title="Job detail" />

        <div className="p-6 space-y-4">
          <div className="text-sm">
            <Link href="/jobs" className="text-blue-600 hover:underline">
              ← Back to Jobs
            </Link>
          </div>

          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{job?.candidate_name ?? "—"}</div>
                <div className="text-sm text-gray-600">
                  {job?.email ?? "—"} {job?.phone ? `• ${job.phone}` : ""}
                </div>
                <div className="text-xs text-gray-400 mt-1">application_id: {applicationId}</div>
              </div>

              <div className="flex items-center gap-2">
                {job?.needs_review ? <Badge variant="warning">review</Badge> : <Badge>ok</Badge>}
                {job?.soft_gate_pic_status ? (
                  <Badge
                    variant={
                      job.soft_gate_pic_status === "pass"
                        ? "default"
                        : job.soft_gate_pic_status === "missing_time"
                        ? "warning"
                        : "danger"
                    }
                  >
                    soft gate {job.soft_gate_pic_status}
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-4 text-sm">
              <div>
                <span className="text-gray-500">Category:</span> {job?.category ?? "—"}
              </div>
              <div>
                <span className="text-gray-500">Employment:</span> {job?.employment_type ?? "—"}
              </div>
              <div>
                <span className="text-gray-500">Location:</span> {job?.location ?? "—"}
              </div>
              <div>
                <span className="text-gray-500">Model:</span> {job?.model ?? "—"}
              </div>

              <div>
                <span className="text-gray-500">Total time:</span> {job?.total_time_hours ?? "—"}
              </div>
              <div>
                <span className="text-gray-500">PIC:</span> {job?.pic_time_hours ?? "—"}
              </div>
              <div>
                <span className="text-gray-500">Turbine:</span> {job?.turbine_time_hours ?? "—"}
              </div>
              <div>
                <span className="text-gray-500">SIC:</span> {job?.sic_time_hours ?? "—"}
              </div>

              <div className="md:col-span-4">
                <span className="text-gray-500">Type ratings:</span>{" "}
                {Array.isArray(job?.type_ratings) && job.type_ratings.length
                  ? job.type_ratings.join(", ")
                  : "—"}
              </div>

              {job?.notes ? (
                <div className="md:col-span-4">
                  <div className="text-gray-500">Notes</div>
                  <div className="mt-1 whitespace-pre-wrap">{job.notes}</div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">Files</div>

            {files.length === 0 ? (
              <div className="text-sm text-gray-500 mt-2">No files found.</div>
            ) : (
              <div className="mt-3 space-y-4">
                {files.map((f: any) => (
                  <FileViewer
                    key={f.id}
                    file={f}
                    downloadUrl={`${jobBase}/api/files/${f.id}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </>
    );
  } catch (e: any) {
    return (
      <>
        <Topbar title="Job detail" />
        <div className="p-6 space-y-4">
          <div className="text-sm">
            <Link href="/jobs" className="text-blue-600 hover:underline">
              ← Back to Jobs
            </Link>
          </div>

          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold text-red-600">Error</div>
            <div className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
              {String(e?.message ?? e)}
            </div>
          </div>
        </div>
      </>
    );
  }
}