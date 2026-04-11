import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { sendGraphMail } from "@/lib/graph-mail-send";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-releases/reply
 *
 * Send a reply email from operations@baker-aviation.com to the vendor,
 * referencing an existing fuel release. Appends the reply to the release
 * status_history for audit tracking.
 *
 * Body: {
 *   releaseId: string,
 *   body: string,    // plain text or HTML
 *   to?: string,     // override recipient (defaults to original vendor email)
 *   cc?: string[],
 * }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const { releaseId, body: messageBody, to, cc } = body as Record<string, unknown>;

  if (!releaseId || !messageBody) {
    return NextResponse.json(
      { error: "releaseId and body are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();

  // Fetch the release
  const { data: release, error: relErr } = await supa
    .from("fuel_releases")
    .select("*")
    .eq("id", releaseId)
    .single();

  if (relErr || !release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  // Look up vendor's contact email
  const { data: vendor } = await supa
    .from("fuel_vendors")
    .select("contact_email, name")
    .ilike("name", release.vendor_name)
    .eq("active", true)
    .limit(1)
    .single();

  const recipient = (to as string) || vendor?.contact_email;
  if (!recipient) {
    return NextResponse.json(
      { error: "No recipient email found for this vendor" },
      { status: 400 },
    );
  }

  const refCode = release.vendor_confirmation || "";
  const strip = (c: string) =>
    c.length === 4 && c.startsWith("K") ? c.slice(1) : c;

  // Preserve ref code in subject for reply matching
  const subject = `Re: Fuel Release Request — ${release.tail_number} at ${strip(release.airport_code)}${refCode ? ` [${refCode}]` : ""}`;

  // Wrap plain text body in basic HTML
  const bodyHtml = String(messageBody)
    .split("\n")
    .map((line) => `<p style="margin:0 0 8px;">${line.replace(/</g, "&lt;").replace(/>/g, "&gt;") || "&nbsp;"}</p>`)
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:600px;margin:0 auto;padding:20px;font-size:14px;line-height:1.5;">
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
  <p style="font-size:11px;color:#9ca3af;">
    Baker Aviation Operations${refCode ? ` &bull; Ref: <strong>${refCode}</strong>` : ""}<br>
    <a href="mailto:operations@baker-aviation.com" style="color:#1e3a5f;">operations@baker-aviation.com</a>
  </p>
</body>
</html>`.trim();

  const ccList = Array.isArray(cc)
    ? (cc as string[]).filter(Boolean)
    : undefined;

  const result = await sendGraphMail({
    to: recipient,
    subject,
    html,
    cc: ccList,
  });

  if (!result.success) {
    return NextResponse.json(
      { error: result.error ?? "Email send failed" },
      { status: 500 },
    );
  }

  // Append reply to status_history
  const now = new Date().toISOString();
  const newHistoryEntry = {
    status: release.status,
    at: now,
    by: auth.email || auth.userId,
    note: `Reply sent to ${recipient}${ccList?.length ? ` (cc: ${ccList.join(", ")})` : ""}: "${String(messageBody).slice(0, 200)}"`,
  };

  const updatedHistory = [...(release.status_history ?? []), newHistoryEntry];

  await supa
    .from("fuel_releases")
    .update({
      status_history: updatedHistory,
      updated_at: now,
    })
    .eq("id", releaseId);

  return NextResponse.json({
    ok: true,
    message: `Reply sent to ${recipient}`,
  });
}
