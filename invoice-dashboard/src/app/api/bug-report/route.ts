import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const BUCKET = "bug-reports";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const description = (formData.get("description") as string)?.trim();
  if (!description) {
    return NextResponse.json({ error: "Description is required" }, { status: 400 });
  }

  const expected = (formData.get("expected") as string)?.trim() || null;
  const section = (formData.get("section") as string) || "general";
  const priority = parseInt(formData.get("priority") as string) || 50;
  const pathname = (formData.get("pathname") as string) || "/";
  const viewport = (formData.get("viewport") as string) || "";
  const userAgent = (formData.get("userAgent") as string) || "";
  const screenshot = formData.get("screenshot") as File | null;

  const sb = createServiceClient();
  let screenshotUrl: string | null = null;

  // Upload screenshot if provided
  if (screenshot && typeof screenshot !== "string" && screenshot.size > 0) {
    const ts = Date.now();
    const path = `${auth.userId}/${ts}.png`;
    const buf = Buffer.from(await screenshot.arrayBuffer());

    const { error: uploadErr } = await sb.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: "image/png", upsert: true });

    if (uploadErr) {
      // Bucket may not exist — create and retry
      if (uploadErr.message?.includes("not found") || uploadErr.statusCode === "404") {
        await sb.storage.createBucket(BUCKET, { public: true });
        const { error: retryErr } = await sb.storage
          .from(BUCKET)
          .upload(path, buf, { contentType: "image/png", upsert: true });
        if (retryErr) {
          console.error("Screenshot upload failed:", retryErr);
        } else {
          screenshotUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
        }
      } else {
        console.error("Screenshot upload failed:", uploadErr);
      }
    } else {
      screenshotUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    }
  }

  // Map route to likely file path for the Claude prompt
  const routeSegment = pathname.split("/").filter(Boolean)[0] || "";
  const likelyFile = routeSegment
    ? `invoice-dashboard/src/app/${routeSegment}/page.tsx`
    : "invoice-dashboard/src/app/page.tsx";

  // Build Claude prompt
  const claudePrompt = [
    `Bug report from ${auth.email} on ${pathname}:`,
    ``,
    `**Issue:** ${description}`,
    expected ? `**Expected:** ${expected}` : null,
    `**Route:** ${pathname}`,
    `**Viewport:** ${viewport}`,
    screenshotUrl ? `**Screenshot:** ${screenshotUrl}` : null,
    ``,
    `Investigate this issue on the ${section} page. Start by reading the page component at \`${likelyFile}\` and any related API routes or child components. Reproduce the issue, identify the root cause, and fix it.`,
  ]
    .filter(Boolean)
    .join("\n");

  // Build ticket body with metadata
  const body = [
    description,
    expected ? `\n**Expected:** ${expected}` : null,
    `\n---`,
    `**Page:** ${pathname}`,
    `**Reporter:** ${auth.email}`,
    `**Viewport:** ${viewport}`,
    `**User Agent:** ${userAgent}`,
    screenshotUrl ? `**Screenshot:** ${screenshotUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const title = description.length > 80 ? description.slice(0, 77) + "..." : description;

  const { data, error } = await sb
    .from("admin_tickets")
    .insert({
      title,
      body,
      priority,
      claude_prompt: claudePrompt,
      section,
      labels: ["bug-report", "user-reported"],
      screenshot_url: screenshotUrl,
      reported_by: auth.email,
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket: data });
}
