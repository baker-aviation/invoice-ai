import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
};

/**
 * GET /api/pilot/bulletins — list bulletins
 * Optional ?category= filter
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const category = req.nextUrl.searchParams.get("category");
  const supa = createServiceClient();

  let query = supa
    .from("pilot_bulletins")
    .select("id, title, summary, category, published_at, pdf_filename, video_url, created_at")
    .order("published_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[pilot/bulletins] list error:", error);
    return NextResponse.json({ error: "Failed to list bulletins" }, { status: 500 });
  }

  return NextResponse.json({ bulletins: data });
}

/**
 * POST /api/pilot/bulletins — create a bulletin (admin only)
 * Multipart form: title, summary, category, pdf (file), video_url (optional)
 * Uploads PDF to GCS and posts summary to #pilots Slack channel.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const title = (formData.get("title") as string)?.trim();
  const summary = (formData.get("summary") as string)?.trim() || null;
  const category = (formData.get("category") as string)?.trim();
  const videoUrl = (formData.get("video_url") as string)?.trim() || null;
  const file = formData.get("pdf") as File | null;

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!category || !CATEGORY_LABELS[category]) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  let gcsBucket: string | null = null;
  let gcsKey: string | null = null;
  let pdfFilename: string | null = null;

  // Upload PDF to GCS if provided
  if (file) {
    if (!file.name.match(/\.pdf$/i) && file.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF files are allowed" }, { status: 400 });
    }
    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 50MB)" }, { status: 400 });
    }

    try {
      const { Storage } = await import("@google-cloud/storage");
      let storage: InstanceType<typeof Storage>;

      const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
      if (b64Key) {
        const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
        storage = new Storage({ credentials: creds, projectId: creds.project_id });
      } else {
        storage = new Storage();
      }

      gcsBucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      const bucket = storage.bucket(gcsBucket);

      const safeName = file.name.replace(/\//g, "_");
      const ts = Date.now();
      gcsKey = `pilot-bulletins/${category}/${ts}-${safeName}`;
      pdfFilename = file.name;

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const blob = bucket.file(gcsKey);
      await blob.save(buffer, {
        contentType: "application/pdf",
      });
    } catch (err) {
      console.error("[pilot/bulletins] GCS upload error:", err);
      return NextResponse.json({ error: "Failed to upload PDF" }, { status: 500 });
    }
  }

  // Insert into database
  const supa = createServiceClient();
  const { data: bulletin, error: dbErr } = await supa
    .from("pilot_bulletins")
    .insert({
      title,
      summary,
      category,
      created_by: auth.userId,
      pdf_gcs_bucket: gcsBucket,
      pdf_gcs_key: gcsKey,
      pdf_filename: pdfFilename,
      video_url: videoUrl,
    })
    .select("id, title, summary, category, published_at, pdf_filename, video_url")
    .single();

  if (dbErr) {
    console.error("[pilot/bulletins] insert error:", dbErr);
    return NextResponse.json({ error: "Failed to create bulletin" }, { status: 500 });
  }

  // Post to #pilots Slack channel
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (slackToken && bulletin) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://baker-ai-gamma.vercel.app";
      const bulletinUrl = `${appUrl}/pilot/bulletins/${bulletin.id}`;
      const categoryLabel = CATEGORY_LABELS[category] || category;

      const slackPayload = {
        channel: "C04AM137PEE",
        text: `New ${categoryLabel} Bulletin: ${title}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `📋 *New ${categoryLabel} Bulletin*\n*${title}*${summary ? `\n${summary}` : ""}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "View Bulletin", emoji: true },
                url: bulletinUrl,
              },
            ],
          },
        ],
      };

      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slackPayload),
      });
      const slackData = await res.json();

      if (slackData.ok && slackData.ts) {
        await supa
          .from("pilot_bulletins")
          .update({ slack_ts: slackData.ts })
          .eq("id", bulletin.id);
      }
    } catch (err) {
      // Non-blocking — bulletin was created, Slack is best-effort
      console.error("[pilot/bulletins] Slack post error:", err);
    }
  }

  return NextResponse.json({ bulletin }, { status: 201 });
}
