import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

const CHANNEL = "C0AQ54QT98B"; // #hiring-pipeline-updates

function verifyCronSecret(req: NextRequest): boolean {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  return secret === process.env.CRON_SECRET;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();

  // Fetch candidates in Tim's stages
  const { data: timsReview } = await supa
    .from("job_application_parse")
    .select("candidate_name, email, created_at, interest_check_response")
    .eq("pipeline_stage", "tims_review")
    .is("deleted_at", null)
    .is("rejected_at", null)
    .order("created_at", { ascending: true });

  const { data: interviewPost } = await supa
    .from("job_application_parse")
    .select("candidate_name, email, created_at")
    .eq("pipeline_stage", "interview_post")
    .is("deleted_at", null)
    .is("rejected_at", null)
    .order("created_at", { ascending: true });

  // Fetch candidates in PRD Review + check for PRD files
  const { data: prdReview } = await supa
    .from("job_application_parse")
    .select("application_id, candidate_name, email, created_at, id")
    .eq("pipeline_stage", "prd_faa_review")
    .is("deleted_at", null)
    .is("rejected_at", null)
    .order("created_at", { ascending: true });

  // Check which PRD candidates have files attached
  const prdIds = (prdReview ?? []).map((c) => c.id);
  let prdFilesMap = new Set<number>();
  if (prdIds.length > 0) {
    const { data: prdFiles } = await supa
      .from("job_application_files")
      .select("linked_parse_id, file_category")
      .in("linked_parse_id", prdIds)
      .eq("file_category", "prd");
    for (const f of prdFiles ?? []) {
      if (f.linked_parse_id) prdFilesMap.add(f.linked_parse_id);
    }
  }

  // Build Slack message blocks
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 Hiring Pipeline Daily Summary", emoji: true },
    },
    { type: "divider" },
  ];

  // Tim's Review section
  const timsCount = (timsReview ?? []).length;
  let timsText = timsCount === 0 ? "_No candidates in Tim's Review_" : "";
  for (const c of timsReview ?? []) {
    const interest = c.interest_check_response === "yes" ? " ✅ Interested"
      : c.interest_check_response === "no" ? " ❌ Not interested"
      : "";
    timsText += `• ${c.candidate_name ?? "Unknown"}${interest}\n`;
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Tim's Review* (${timsCount})\n${timsText}` },
  });

  // Interview Complete section
  const postCount = (interviewPost ?? []).length;
  let postText = postCount === 0 ? "_No candidates in Interview Complete_" : "";
  for (const c of interviewPost ?? []) {
    postText += `• ${c.candidate_name ?? "Unknown"}\n`;
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Interview Complete* (${postCount})\n${postText}` },
  });

  blocks.push({ type: "divider" });

  // Mike's PRD Review section
  const prdCount = (prdReview ?? []).length;
  const needsPrd = (prdReview ?? []).filter((c) => !prdFilesMap.has(c.id));
  let prdText = prdCount === 0 ? "_No candidates in PRD Review_" : "";
  for (const c of prdReview ?? []) {
    const hasPrd = prdFilesMap.has(c.id);
    prdText += `• ${c.candidate_name ?? "Unknown"} ${hasPrd ? "✅ PRD uploaded" : "🔴 Needs PRD"}\n`;
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*PRD / FAA Review* (${prdCount} total, ${needsPrd.length} need PRD)\n${prdText}` },
  });

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_Sent at ${new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true })} ET_` }],
  });

  await postSlackMessage({
    channel: CHANNEL,
    text: "Hiring Pipeline Daily Summary",
    blocks,
  });

  return NextResponse.json({ ok: true, timsReview: timsCount, interviewPost: postCount, prdReview: prdCount });
}
