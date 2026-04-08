import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

type RouteCtx = { params: Promise<{ id: string }> };

const SYSTEM_PROMPT = `You are a meeting analysis assistant for Baker Aviation's internal operations team.
Your job is to watch a meeting recording (via transcript and screenshots) and extract actionable work tickets.

For each action item, feature request, bug report, or follow-up you identify:
- Write a clear, specific ticket title (imperative form, e.g. "Add fuel surcharge validation to invoice parser")
- Write a description with enough context that someone who wasn't in the meeting could pick it up
- Classify the type: task, bug, feature, action_item, or follow_up
- Set priority: critical, high, medium, or low
- If someone is mentioned as the owner/assignee, include their name as assignee_hint
- Include the approximate timestamp(s) in the video where this was discussed (in seconds)

Return ONLY valid JSON in this exact format:
{
  "summary": "Brief 2-3 sentence meeting summary",
  "tickets": [
    {
      "title": "...",
      "description": "...",
      "ticket_type": "task|bug|feature|action_item|follow_up",
      "priority": "critical|high|medium|low",
      "assignee_hint": "Person Name or null",
      "timestamp_secs": [45, 120]
    }
  ]
}

Be thorough but don't fabricate tickets. Only create tickets for things that were actually discussed and need action.`;

/**
 * POST /api/admin/meetings/[id]/generate-tickets
 * Sends transcript + sampled screenshots to Claude for ticket generation.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const meetingId = parseInt(id, 10);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  const sb = createServiceClient();

  // Fetch meeting
  const { data: meeting, error: meetingErr } = await sb
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .single();

  if (meetingErr || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  if (!meeting.transcript) {
    return NextResponse.json({ error: "Meeting has no transcript yet" }, { status: 400 });
  }

  // Update status to generating
  await sb.from("meetings").update({ status: "generating", updated_at: new Date().toISOString() }).eq("id", meetingId);

  try {
    // Fetch screenshots
    const { data: allScreenshots } = await sb
      .from("meeting_screenshots")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("time_sec", { ascending: true });

    // Sample ~20 screenshots max to keep token costs reasonable
    const screenshots = allScreenshots || [];
    const maxImages = 20;
    const step = screenshots.length > maxImages ? Math.ceil(screenshots.length / maxImages) : 1;
    const sampled = screenshots.filter((_, i) => i % step === 0).slice(0, maxImages);

    // Fetch screenshot images from GCS
    const storage = await getGcsStorage();
    const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";

    const imageBlocks: Anthropic.ImageBlockParam[] = [];
    for (const s of sampled) {
      try {
        const [buffer] = await storage.bucket(bucket).file(s.gcs_key).download();
        const base64 = buffer.toString("base64");
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: base64,
          },
        });
      } catch {
        // Skip failed screenshots
      }
    }

    // Build Claude message
    const contentBlocks: Anthropic.ContentBlockParam[] = [
      { type: "text", text: `Meeting transcript:\n\n${meeting.transcript}` },
    ];

    if (imageBlocks.length > 0) {
      contentBlocks.push({
        type: "text",
        text: `\n\nBelow are ${imageBlocks.length} screenshots from the meeting video, taken every ~${Math.round((meeting.duration_sec || 60) / imageBlocks.length)}s:`,
      });
      contentBlocks.push(...imageBlocks);
    }

    contentBlocks.push({
      type: "text",
      text: "\n\nAnalyze this meeting and generate actionable work tickets. Return ONLY the JSON object.",
    });

    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: contentBlocks }],
    });

    // Parse Claude's response
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = textBlock.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const result = JSON.parse(jsonStr);

    // Map screenshot timestamps to screenshot IDs
    const screenshotMap = screenshots.reduce(
      (acc, s) => { acc[Math.round(Number(s.time_sec))] = s.id; return acc; },
      {} as Record<number, number>,
    );

    // Insert tickets
    const ticketRows = (result.tickets || []).map(
      (t: { title: string; description: string; ticket_type: string; priority: string; assignee_hint: string; timestamp_secs: number[] }) => {
        // Find closest screenshot IDs for each timestamp
        const screenshotIds = (t.timestamp_secs || []).map((ts: number) => {
          const closest = Object.keys(screenshotMap)
            .map(Number)
            .reduce((prev, curr) => (Math.abs(curr - ts) < Math.abs(prev - ts) ? curr : prev), 0);
          return screenshotMap[closest];
        }).filter(Boolean);

        return {
          meeting_id: meetingId,
          title: t.title,
          description: t.description,
          ticket_type: t.ticket_type || "task",
          priority: t.priority || "medium",
          assignee_hint: t.assignee_hint || null,
          timestamp_secs: t.timestamp_secs || [],
          screenshot_ids: screenshotIds,
          status: "pending",
        };
      },
    );

    if (ticketRows.length > 0) {
      const { error: insertErr } = await sb.from("meeting_tickets").insert(ticketRows);
      if (insertErr) throw new Error(`Failed to insert tickets: ${insertErr.message}`);
    }

    // Update meeting status and summary
    await sb
      .from("meetings")
      .update({
        status: "tickets_ready",
        summary: result.summary || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", meetingId);

    return NextResponse.json({
      ok: true,
      summary: result.summary,
      ticket_count: ticketRows.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Ticket generation failed";
    console.error("generate-tickets error:", msg);

    await sb
      .from("meetings")
      .update({ status: "transcribed", updated_at: new Date().toISOString() })
      .eq("id", meetingId);

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
