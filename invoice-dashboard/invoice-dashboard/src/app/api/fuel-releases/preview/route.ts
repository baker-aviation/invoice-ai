import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import {
  buildReleaseEmailHtml,
  makeRefCode,
} from "@/lib/fuelVendors/adapters/email";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-releases/preview
 *
 * Returns a preview of the fuel release email that would be sent,
 * without actually sending it. Used by the dashboard to show draft emails.
 *
 * Body: same as /api/fuel-releases/submit
 * Returns: { vendor, to, subject, html, releaseType }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json().catch(() => ({}));
  const {
    airport, fbo, tailNumber, vendorName, gallons, quotedPrice, date, notes,
  } = body as Record<string, unknown>;

  if (!airport || !tailNumber || !gallons || !date) {
    return NextResponse.json(
      { error: "airport, tailNumber, gallons, and date are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const vendorNameStr = (vendorName as string) ?? "";

  // Look up vendor from DB
  const { data: dbVendor } = await supa
    .from("fuel_vendors")
    .select("*")
    .eq("active", true)
    .or(`slug.eq.${vendorNameStr.toLowerCase()},name.ilike.%${vendorNameStr}%`)
    .limit(1)
    .single();

  const strip = (c: string) =>
    c.length === 4 && c.startsWith("K") ? c.slice(1) : c;

  // Generate a preview ref code (will be regenerated on actual send)
  const previewRefCode = makeRefCode(crypto.randomUUID());

  if (!dbVendor || dbVendor.release_type !== "email" || !dbVendor.contact_email) {
    // Card or unknown vendor — no email to preview
    return NextResponse.json({
      releaseType: dbVendor?.release_type ?? "manual",
      vendor: dbVendor?.name ?? (vendorNameStr || "Unknown"),
      to: null,
      subject: null,
      html: null,
      message: dbVendor?.release_type === "card"
        ? `${dbVendor.name}: ${dbVendor.notes || "Use Physical Horizon Card"}. No email will be sent.`
        : "No email vendor found. Release will be tracked manually with a Slack notification.",
    });
  }

  // Build the email preview
  const destination = dbVendor.requires_destination
    ? ((notes as string) || "— destination required —")
    : undefined;

  const subject = `Fuel Release Request — ${tailNumber} at ${strip(airport as string)} [${previewRefCode}]`;

  const html = buildReleaseEmailHtml({
    tailNumber: tailNumber as string,
    airport: airport as string,
    fbo: (fbo as string) || "",
    gallons: Number(gallons),
    date: date as string,
    refCode: previewRefCode,
    vendorName: dbVendor.name,
    destination,
    notes: !dbVendor.requires_destination ? (notes as string) || undefined : undefined,
  });

  return NextResponse.json({
    releaseType: "email",
    vendor: dbVendor.name,
    to: dbVendor.contact_email,
    subject,
    html,
    message: null,
    // Include editable fields so the modal can let users tweak
    editable: {
      notes: (notes as string) || "",
      gallons: Number(gallons),
      fbo: (fbo as string) || "",
      destination: destination || "",
      requiresDestination: dbVendor.requires_destination,
    },
  });
}
