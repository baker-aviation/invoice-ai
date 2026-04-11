import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getVendorAdapter, resolveVendorId } from "@/lib/fuelVendors";
import { postSlackMessage, resolveFuelSlackChannel } from "@/lib/slack";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-releases/submit
 *
 * Submit a fuel release request for a specific leg. Resolves the vendor adapter,
 * calls it (or falls through to manual), inserts the DB record, and notifies Slack.
 *
 * Body: {
 *   airport: string,        // ICAO
 *   fbo: string,
 *   tailNumber: string,
 *   vendorName: string,     // "EVO", "World Fuel Services", "Avfuel", etc.
 *   gallons: number,
 *   quotedPrice?: number,   // price/gal from the plan
 *   date: string,           // YYYY-MM-DD
 *   notes?: string,
 *   planLinkToken?: string,
 *   planLegIndex?: number,
 * }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const {
    airport, fbo, tailNumber, vendorName,
    gallons, quotedPrice, date, notes,
    planLinkToken, planLegIndex,
    toOverride, cc,
  } = body as Record<string, unknown>;

  if (!airport || !tailNumber || !gallons || !date) {
    return NextResponse.json(
      { error: "airport, tailNumber, gallons, and date are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();

  // Look up vendor from DB first, fall back to legacy name resolution
  const vendorNameStr = (vendorName as string) ?? "";
  let vendorId;
  let vendorDbName = vendorNameStr;
  let releaseType: string | undefined;

  const { data: dbVendor } = await supa
    .from("fuel_vendors")
    .select("slug, name, release_type, contact_email")
    .eq("active", true)
    .or(`slug.eq.${vendorNameStr.toLowerCase()},name.ilike.%${vendorNameStr}%`)
    .limit(1)
    .single();

  if (dbVendor) {
    releaseType = dbVendor.release_type;
    vendorDbName = dbVendor.name;
  }

  vendorId = resolveVendorId(vendorNameStr, releaseType);
  const adapter = getVendorAdapter(vendorId);

  // Call the vendor adapter
  const ccList = Array.isArray(cc) ? (cc as string[]).filter(Boolean) : undefined;
  const releaseReq = {
    airport: airport as string,
    fbo: (fbo as string) ?? "",
    tailNumber: tailNumber as string,
    gallons: Number(gallons),
    requestedPrice: quotedPrice ? Number(quotedPrice) : undefined,
    date: date as string,
    notes: (notes as string) ?? undefined,
    submittedBy: auth.userId,
    submittedByEmail: auth.email,
    planLinkToken: (planLinkToken as string) ?? undefined,
    planLegIndex: planLegIndex != null ? Number(planLegIndex) : undefined,
    toOverride: (toOverride as string) ?? undefined,
    cc: ccList,
  };

  let adapterResult;
  try {
    adapterResult = await adapter.submitFuelRelease(releaseReq);
  } catch (err) {
    console.error(`[fuel-release] ${adapter.vendorName} adapter error:`, err);
    adapterResult = {
      success: false,
      status: "failed" as const,
      message: `Adapter error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Insert DB record
  const now = new Date().toISOString();
  const row = {
    submitted_by: auth.userId,
    submitted_by_email: auth.email,
    tail_number: tailNumber as string,
    airport_code: airport as string,
    fbo_name: (fbo as string) || null,
    departure_date: date as string,
    vendor_id: vendorId,
    vendor_name: vendorDbName || adapter.vendorName,
    gallons_requested: Number(gallons),
    quoted_price: quotedPrice ? Number(quotedPrice) : null,
    status: adapterResult.status,
    vendor_confirmation: adapterResult.vendorConfirmation ?? null,
    status_history: [{ status: adapterResult.status, at: now, by: auth.userId }],
    plan_link_token: (planLinkToken as string) || null,
    plan_leg_index: planLegIndex != null ? Number(planLegIndex) : null,
    notes: (notes as string) || null,
  };

  const { data: inserted, error: insertErr } = await supa
    .from("fuel_releases")
    .insert(row)
    .select("id")
    .single();

  if (insertErr) {
    console.error("[fuel-release] DB insert error:", insertErr.message);
    return NextResponse.json({ error: "Failed to save release" }, { status: 500 });
  }

  // Slack notification — post to the tail's channel
  const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
  const airportLabel = strip(airport as string);
  const priceLabel = quotedPrice ? ` @ $${Number(quotedPrice).toFixed(2)}/gal` : "";

  const { data: src } = await supa
    .from("ics_sources")
    .select("slack_channel_id")
    .eq("label", (tailNumber as string).toUpperCase())
    .single();
  const channel = await resolveFuelSlackChannel(src?.slack_channel_id ?? null);

  await postSlackMessage({
    channel,
    text: `Fuel release: ${tailNumber} at ${airportLabel}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Fuel Release Requested*`,
          `*Tail:* ${tailNumber}  *Airport:* ${airportLabel}`,
          `*FBO:* ${(fbo as string) || "—"}  *Vendor:* ${vendorDbName || adapter.vendorName}`,
          `*Gallons:* ${Number(gallons).toLocaleString()}${priceLabel}`,
          `*Date:* ${date}`,
          `*Status:* ${adapterResult.status}`,
          adapterResult.vendorConfirmation ? `*Confirmation:* ${adapterResult.vendorConfirmation}` : "",
          adapterResult.message?.includes("email sent") ? `_${adapterResult.message}_` : "",
        ].filter(Boolean).join("\n"),
      },
    }],
  });

  return NextResponse.json({
    ok: true,
    id: inserted.id,
    vendorId,
    status: adapterResult.status,
    vendorConfirmation: adapterResult.vendorConfirmation ?? null,
    message: adapterResult.message,
  });
}
