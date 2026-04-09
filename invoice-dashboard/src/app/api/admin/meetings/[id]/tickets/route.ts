import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getStorage } from "@/lib/gcs";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/meetings/[id]/tickets
 * List all tickets for a meeting.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("meeting_tickets")
    .select("*")
    .eq("meeting_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ tickets: data || [] });
}

/**
 * PATCH /api/admin/meetings/[id]/tickets
 * Update a ticket: accept/reject, edit, push to admin_tickets.
 * Body: { ticket_id, ...updates }
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const body = await req.json();
  const { ticket_id, action, ...updates } = body;

  if (!ticket_id) {
    return NextResponse.json({ error: "ticket_id is required" }, { status: 400 });
  }

  const sb = createServiceClient();

  // Special action: accept and push to admin_tickets + GitHub issue
  if (action === "accept") {
    // Fetch the meeting ticket + meeting title
    const [ticketResult, meetingResult] = await Promise.all([
      sb.from("meeting_tickets").select("*").eq("id", ticket_id).eq("meeting_id", id).single(),
      sb.from("meetings").select("id, title").eq("id", id).single(),
    ]);

    if (ticketResult.error || !ticketResult.data) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    const ticket = ticketResult.data;
    const meetingTitle = meetingResult.data?.title || "Meeting";

    // Create an admin_ticket from it
    const priorityMap: Record<string, number> = {
      critical: 10,
      high: 25,
      medium: 50,
      low: 75,
    };

    const { data: adminTicket, error: adminErr } = await sb
      .from("admin_tickets")
      .insert({
        title: ticket.title,
        body: ticket.description,
        priority: priorityMap[ticket.priority] || 50,
        labels: [ticket.ticket_type, "from-meeting"],
        section: "general",
        status: "open",
        created_by: auth.userId,
      })
      .select()
      .single();

    if (adminErr) {
      return NextResponse.json({ error: adminErr.message }, { status: 500 });
    }

    // Create GitHub issue with embedded screenshots
    let githubIssueNumber: number | null = null;
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      try {
        const formatTime = (s: number) => {
          const m = Math.floor(s / 60);
          const sec = Math.floor(s % 60);
          return `${m}:${String(sec).padStart(2, "0")}`;
        };

        const timestamps = (ticket.timestamp_secs || []) as number[];
        const timestampStr = timestamps.length > 0
          ? `\n\n**Referenced timestamps:** ${timestamps.map((t: number) => `\`${formatTime(t)}\``).join(", ")}`
          : "";

        // Fetch relevant screenshots from GCS and upload to GitHub
        let screenshotMarkdown = "";
        const screenshotIds = (ticket.screenshot_ids || []) as number[];
        const storage = getStorage();

        if (storage && (screenshotIds.length > 0 || timestamps.length > 0)) {
          const bucket = process.env.GCS_BUCKET || "invoice-ai-487621-files";

          // Get screenshots — by ID if available, otherwise find closest to timestamps
          let screenshotRows: { id: number; gcs_key: string; time_sec: number }[] = [];

          if (screenshotIds.length > 0) {
            const { data } = await sb
              .from("meeting_screenshots")
              .select("id, gcs_key, time_sec")
              .in("id", screenshotIds);
            screenshotRows = data || [];
          } else if (timestamps.length > 0) {
            // Get all screenshots for this meeting, find closest to each timestamp
            const { data: allScreenshots } = await sb
              .from("meeting_screenshots")
              .select("id, gcs_key, time_sec")
              .eq("meeting_id", id)
              .order("time_sec", { ascending: true });

            if (allScreenshots && allScreenshots.length > 0) {
              const seen = new Set<number>();
              for (const ts of timestamps) {
                const closest = allScreenshots.reduce((a, b) =>
                  Math.abs(Number(a.time_sec) - ts) < Math.abs(Number(b.time_sec) - ts) ? a : b,
                );
                if (!seen.has(closest.id)) {
                  seen.add(closest.id);
                  screenshotRows.push(closest);
                }
              }
            }
          }

          // Upload each screenshot to GitHub (max 3 to keep issues clean)
          const toUpload = screenshotRows.slice(0, 3);
          const ghHeaders = {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          };

          for (const ss of toUpload) {
            try {
              const [contents] = await storage.bucket(bucket).file(ss.gcs_key).download();
              const b64 = contents.toString("base64");
              const path = `docs/meeting-screenshots/meeting-${id}/ticket-${ticket_id}-${formatTime(Number(ss.time_sec)).replace(":", "m")}s.jpg`;

              // Check if file already exists (for idempotency)
              const existsRes = await fetch(
                `https://api.github.com/repos/baker-aviation/invoice-ai/contents/${path}`,
                { headers: ghHeaders },
              );

              let sha: string | undefined;
              if (existsRes.ok) {
                const existsData = await existsRes.json();
                sha = existsData.sha;
              }

              const uploadRes = await fetch(
                `https://api.github.com/repos/baker-aviation/invoice-ai/contents/${path}`,
                {
                  method: "PUT",
                  headers: ghHeaders,
                  body: JSON.stringify({
                    message: `Add meeting screenshot (meeting #${id}, ${formatTime(Number(ss.time_sec))})`,
                    content: b64,
                    branch: "main",
                    ...(sha ? { sha } : {}),
                  }),
                },
              );

              if (uploadRes.ok) {
                const rawUrl = `https://raw.githubusercontent.com/baker-aviation/invoice-ai/main/${path}`;
                screenshotMarkdown += `\n\n**Screenshot at ${formatTime(Number(ss.time_sec))}:**\n![${formatTime(Number(ss.time_sec))}](${rawUrl})`;
              }
            } catch (e) {
              console.error(`Failed to upload screenshot ${ss.id}:`, e);
            }
          }
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "https://baker-ai-gamma.vercel.app";
        const meetingUrl = `${appUrl}/admin?tab=super&subtab=meetings&meeting=${id}`;

        const issueBody = `${ticket.description || "No description."}${timestampStr}${screenshotMarkdown}

---
**Source:** [${meetingTitle}](${meetingUrl}) — Meeting #${id}
**Priority:** ${ticket.priority} | **Type:** ${ticket.ticket_type.replace("_", " ")}`;

        const labelMap: Record<string, string> = {
          bug: "bug",
          feature: "enhancement",
          task: "enhancement",
          action_item: "enhancement",
          follow_up: "enhancement",
        };

        const labels = [labelMap[ticket.ticket_type] || "enhancement", "from-meeting"];
        if (ticket.priority === "critical" || ticket.priority === "high") {
          labels.push("priority: high");
        }

        const ghRes = await fetch("https://api.github.com/repos/baker-aviation/invoice-ai/issues", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: ticket.title,
            body: issueBody,
            labels,
          }),
        });

        if (ghRes.ok) {
          const ghData = await ghRes.json();
          githubIssueNumber = ghData.number;
        } else {
          console.error("GitHub issue creation failed:", ghRes.status, await ghRes.text());
        }
      } catch (e) {
        console.error("GitHub issue creation error:", e);
      }
    }

    // Update meeting ticket status
    const ticketUpdate: Record<string, unknown> = {
      status: "accepted",
      admin_ticket_id: adminTicket.id,
    };
    if (githubIssueNumber) {
      ticketUpdate.linear_issue_id = `gh#${githubIssueNumber}`;
    }

    await sb
      .from("meeting_tickets")
      .update(ticketUpdate)
      .eq("id", ticket_id);

    return NextResponse.json({
      ok: true,
      admin_ticket: adminTicket,
      github_issue: githubIssueNumber ? `#${githubIssueNumber}` : null,
    });
  }

  // Special action: reject
  if (action === "reject") {
    await sb.from("meeting_tickets").update({ status: "rejected" }).eq("id", ticket_id);
    return NextResponse.json({ ok: true });
  }

  // General update (title, description, priority, ticket_type)
  const allowed: Record<string, unknown> = {};
  for (const key of ["title", "description", "priority", "ticket_type", "assignee_hint", "status"]) {
    if (key in updates) allowed[key] = updates[key];
  }

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await sb
    .from("meeting_tickets")
    .update(allowed)
    .eq("id", ticket_id)
    .eq("meeting_id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket: data });
}

/**
 * DELETE /api/admin/meetings/[id]/tickets?ticket_id=123
 */
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get("ticket_id");

  if (!ticketId) {
    return NextResponse.json({ error: "ticket_id is required" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb
    .from("meeting_tickets")
    .delete()
    .eq("id", ticketId)
    .eq("meeting_id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
