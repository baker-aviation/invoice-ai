import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { Badge } from "@/components/Badge";
import { fetchJobDetail, fetchLinkedLors, fetchPreviousRejections } from "@/lib/jobApi";
import FileViewer from "./FileViewer";
import FormLinkButton from "./FormLinkButton";
import AttachFileButton from "./AttachFileButton";
import TypeRatingsEditor from "./TypeRatingsEditor";
import ProfileEditor from "./ProfileEditor";
import ReviewBadge from "./ReviewBadge";
import HrReviewedBadge from "./HrReviewedBadge";
import PushToScreeningButton from "./PushToScreeningButton";
import NextStepButton from "./NextStepButton";
import InlineNotes from "./InlineNotes";
import OfferPreview from "./OfferPreview";

function fmtDate(s: any) {
  return String(s ?? "").replace("T", " ").replace("+00:00", "Z");
}

function sentenceCase(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CATEGORY_LABELS: Record<string, string> = {
  pilot_pic: "Pilot — PIC",
  pilot_sic: "Pilot — SIC",
  dispatcher: "Dispatcher",
  maintenance: "Maintenance",
  sales: "Sales",
  hr: "HR",
  admin: "Admin",
  management: "Management",
  line_service: "Line Service",
  other: "Other",
};

const RATING_LABELS: Record<string, string> = {
  "CE-750": "CE-750 (Citation X)",
  "CE750": "CE-750 (Citation X)",
  "C750": "C750 (Citation X)",
  "CL-300": "CL-300 (Challenger 300)",
  "CL-350": "CL-350 (Challenger 350)",
  "CL-30": "CL-30 (Challenger 300)",
};

function categoryLabel(raw: string | null): string {
  if (!raw) return "—";
  return CATEGORY_LABELS[raw] ?? raw;
}

function ratingLabel(code: string): string {
  for (const [key, label] of Object.entries(RATING_LABELS)) {
    if (code.toUpperCase().includes(key.toUpperCase())) return label;
  }
  return code;
}

function detectPart135(job: any): boolean {
  if (job.has_part_135 === true) return true;
  if (job.has_part_135 === false) return false;
  const haystack = [job.notes, ...(Array.isArray(job.type_ratings) ? job.type_ratings : [])]
    .join(" ")
    .toLowerCase();
  return /part\s?135|far\s?135|on-demand|charter/.test(haystack);
}

function detectPart121(job: any): boolean {
  if (job.has_part_121 === true) return true;
  if (job.has_part_121 === false) return false;
  const haystack = [job.notes, ...(Array.isArray(job.type_ratings) ? job.type_ratings : [])]
    .join(" ")
    .toLowerCase();
  return /part\s?121|far\s?121|airline|air carrier/.test(haystack);
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const raw = id;
  const applicationId = String(raw ?? "").match(/\d+/)?.[0] || "";

  if (!applicationId) {
    throw new Error(`Invalid id param: ${String(raw)}`);
  }

  try {
    const data = await fetchJobDetail(applicationId);
    const job = data.job;
    const files = data.files ?? [];
    const lors = await fetchLinkedLors(job?.id);
    const isPilot = job?.category === "pilot_pic" || job?.category === "pilot_sic";

    // Check for previously rejected applications with same email, phone, or name
    const previousRejections = await fetchPreviousRejections(
      { email: job?.email, phone: job?.phone, candidate_name: job?.candidate_name },
      job.id,
    );

    const isRejected = !!job?.rejected_at;

    return (
      <>
        <Topbar title="Job detail" />

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-4 text-sm">
            <Link href="/jobs" className="text-blue-600 hover:underline">
              ← Back to Jobs
            </Link>
            <Link href="/jobs/pipeline" className="text-blue-600 hover:underline">
              ← Return to Pipeline
            </Link>
          </div>

          {/* Rejection banner */}
          {isRejected && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="text-red-600 font-semibold text-sm">Rejected</span>
                <span className="text-xs text-red-400">
                  {fmtDate(job.rejected_at)}
                </span>
              </div>
              {job.rejection_reason && (
                <div className="mt-1 text-sm text-red-700">{job.rejection_reason}</div>
              )}
            </div>
          )}

          {/* Previously rejected alert */}
          {previousRejections.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <div className="text-sm font-semibold text-amber-800">
                Previously Rejected Application{previousRejections.length > 1 ? "s" : ""}
              </div>
              <div className="mt-1 text-xs text-amber-700 space-y-1">
                {previousRejections.map((r) => (
                  <div key={r.id}>
                    <Link
                      href={`/jobs/${r.application_id}`}
                      className="text-amber-800 underline hover:text-amber-900"
                    >
                      Application #{r.application_id}
                    </Link>
                    {" — rejected "}
                    {fmtDate(r.rejected_at)}
                    {r.rejection_reason ? `: ${r.rejection_reason}` : ""}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{job?.candidate_name ?? "—"}</div>
                <div className="text-sm text-gray-600">
                  {job?.email ?? "—"} {job?.phone ? `• ${job.phone}` : ""}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  application_id: {applicationId}
                  {job?.pipeline_stage && (
                    <span className="ml-3 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                      Pipeline: {job.pipeline_stage.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {isRejected && <Badge variant="danger">Rejected</Badge>}
                {job?.previously_rejected && !isRejected && (
                  <Badge variant="warning">Previously Rejected</Badge>
                )}
                <HrReviewedBadge
                  applicationId={Number(applicationId)}
                  initialHrReviewed={!!job?.hr_reviewed}
                />
                <NextStepButton
                  applicationId={Number(applicationId)}
                  currentStage={job?.pipeline_stage ?? null}
                />
                <PushToScreeningButton
                  applicationId={Number(applicationId)}
                  currentStage={job?.pipeline_stage ?? null}
                />
                <ReviewBadge
                  applicationId={Number(applicationId)}
                  initialNeedsReview={job?.needs_review ?? false}
                />
                {isPilot && (
                  job?.soft_gate_pic_status && job.soft_gate_pic_status !== "missing_time" ? (
                    <Badge
                      variant={
                        job.soft_gate_pic_status.toLowerCase() === "pass" || job.soft_gate_pic_status.toLowerCase().startsWith("meets")
                          ? "default"
                          : job.soft_gate_pic_status.toLowerCase().startsWith("close")
                          ? "warning"
                          : "danger"
                      }
                    >
                      PIC gate: {job.soft_gate_pic_status === "pass" ? "Met" : job.soft_gate_pic_status === "fail" ? "Not met" : job.soft_gate_pic_status}
                    </Badge>
                  ) : job?.soft_gate_pic_met === true ? (
                    <Badge variant="default">PIC gate: Met</Badge>
                  ) : job?.soft_gate_pic_met === false ? (
                    <Badge variant="danger">PIC gate: Not met</Badge>
                  ) : null
                )}
              </div>
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-4 text-sm">
              <div>
                <span className="text-gray-500">Category:</span> {categoryLabel(job?.category)}
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

              {isPilot && (
                <>
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
                      ? job.type_ratings.map(ratingLabel).join(", ")
                      : "—"}
                    <TypeRatingsEditor
                      applicationId={Number(applicationId)}
                      initialRatings={Array.isArray(job?.type_ratings) ? job.type_ratings : []}
                      initialHasCitationX={job?.has_citation_x ?? null}
                      initialHasChallenger300={job?.has_challenger_300_type_rating ?? null}
                      initialCategory={job?.category ?? null}
                    />
                  </div>

                  {(detectPart135(job) || detectPart121(job)) && (
                    <div className="md:col-span-4 flex items-center gap-2">
                      <span className="text-gray-500">Experience:</span>
                      {detectPart135(job) && (
                        <span className="inline-block rounded-full border border-orange-200 bg-orange-50 text-orange-700 px-2 py-0.5 text-xs font-semibold">
                          Part 135
                        </span>
                      )}
                      {detectPart121(job) && (
                        <span className="inline-block rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 px-2 py-0.5 text-xs font-semibold">
                          Part 121
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}

              {job?.notes ? (
                <div className="md:col-span-4">
                  <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 border-l-4 border-l-amber-400">
                    <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Notes</div>
                    <div className="mt-1.5 text-sm text-gray-800 whitespace-pre-wrap">{job.notes}</div>
                  </div>
                </div>
              ) : null}

              {/* Inline editable review notes */}
              <div className="md:col-span-4 mt-2">
                <InlineNotes
                  applicationId={Number(applicationId)}
                  initialNotes={job?.structured_notes ?? null}
                />
              </div>
            </div>

            {/* Profile editor (edit/reject/delete actions) */}
            <ProfileEditor
              data={{
                applicationId: Number(applicationId),
                candidate_name: job?.candidate_name ?? null,
                email: job?.email ?? null,
                phone: job?.phone ?? null,
                location: job?.location ?? null,
                category: job?.category ?? null,
                employment_type: job?.employment_type ?? null,
                total_time_hours: job?.total_time_hours ?? null,
                pic_time_hours: job?.pic_time_hours ?? null,
                turbine_time_hours: job?.turbine_time_hours ?? null,
                sic_time_hours: job?.sic_time_hours ?? null,
                notes: job?.notes ?? null,
                structured_notes: job?.structured_notes ?? null,
                rejected_at: job?.rejected_at ?? null,
                rejection_reason: job?.rejection_reason ?? null,
              }}
              currentStage={job?.pipeline_stage ?? null}
            />
          </div>

          {/* Info Session Form Link */}
          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold mb-2">Info Session Form</div>
            <FormLinkButton parseId={job.id} />
          </div>

          {/* Info Session Responses — table layout */}
          {job?.info_session_data && Object.keys(job.info_session_data).length > 0 && (
            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <div className="text-sm font-semibold mb-3">Info Session Responses</div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {Object.entries(job.info_session_data).map(([key, value]) => (
                    <tr key={key}>
                      <td className="py-1.5 pr-4 text-gray-500 whitespace-nowrap align-top font-medium w-1/3">
                        {sentenceCase(key)}
                      </td>
                      <td className="py-1.5 text-gray-900 whitespace-pre-wrap">
                        {String(value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* PRD Document */}
          {(() => {
            const prdFiles = files.filter((f: any) => f.file_category === "prd");
            return (
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-900">PRD Document</h3>
                  <AttachFileButton applicationId={Number(applicationId)} parseId={job.id} defaultCategory="prd" />
                </div>
                {prdFiles.length === 0 ? (
                  <p className="text-sm text-gray-400">No PRD uploaded yet.</p>
                ) : (
                  prdFiles.map((f: any) => (
                    <a key={f.id} href={f.signed_url} target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 text-sm text-blue-600 hover:underline">
                      <span>📄</span> {f.filename}
                    </a>
                  ))
                )}
              </div>
            );
          })()}

          {/* Offer Letter */}
          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Offer Letter</div>
              <OfferPreview applicationId={Number(applicationId)} initialOfferStatus={job.offer_status ?? null} />
            </div>
          </div>

          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Files</div>
              <AttachFileButton applicationId={Number(applicationId)} parseId={job.id} />
            </div>

            {files.length === 0 ? (
              <div className="text-sm text-gray-500 mt-2">No files found.</div>
            ) : (
              <div className="mt-3 space-y-4">
                {files.map((f: any) => (
                  <FileViewer
                    key={f.id}
                    file={f}
                    downloadUrl={f.signed_url ?? null}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Letters of Recommendation</div>
            </div>
            {lors.length === 0 ? (
              <div className="text-sm text-gray-500 mt-2">No LORs attached.</div>
            ) : (
              <div className="mt-3 space-y-4">
                {lors.map((f: any) => (
                  <FileViewer
                    key={f.id}
                    file={f}
                    downloadUrl={f.signed_url ?? null}
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
          <div className="flex items-center gap-4 text-sm">
            <Link href="/jobs" className="text-blue-600 hover:underline">
              ← Back to Jobs
            </Link>
            <Link href="/jobs/pipeline" className="text-blue-600 hover:underline">
              ← Return to Pipeline
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
