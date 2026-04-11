/**
 * Email-based fuel vendor adapter.
 *
 * Sends a fuel release request email to the vendor's contact address via
 * Microsoft Graph API (operations@baker-aviation.com). Includes a unique
 * reference code in the subject line for auto-matching vendor replies.
 *
 * This is the interim solution while vendor APIs (EVO, WFS, Avfuel) get built.
 */

import { sendGraphMail } from "@/lib/graph-mail-send";
import { createServiceClient } from "@/lib/supabase/service";
import type {
  FuelVendorAdapter,
  VendorCapabilities,
  RealTimePriceRequest,
  RealTimePriceResponse,
  FuelReleaseRequest,
  FuelReleaseResponse,
  FuelReleaseStatusResponse,
} from "../types";

/** Generate a short ref code from a UUID: BR-{first 8 chars uppercase} */
export function makeRefCode(releaseId: string): string {
  return `BR-${releaseId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** Strip K prefix from US ICAO codes for display */
function strip(code: string): string {
  return code.length === 4 && code.startsWith("K") ? code.slice(1) : code;
}

export function buildReleaseEmailHtml(opts: {
  tailNumber: string;
  airport: string;
  fbo: string;
  gallons: number;
  date: string;
  refCode: string;
  vendorName: string;
  destination?: string;
  notes?: string;
}): string {
  const rows = [
    ["Aircraft", opts.tailNumber],
    ["Airport", `${strip(opts.airport)} (${opts.airport})`],
    ["FBO", opts.fbo || "—"],
    ["Gallons Requested", Math.round(opts.gallons).toLocaleString()],
    ["Date Needed", opts.date],
  ];

  if (opts.destination) {
    rows.push(["Destination", opts.destination]);
  }

  if (opts.notes) {
    rows.push(["Notes", opts.notes]);
  }

  rows.push(["Reference", opts.refCode]);

  const tableRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${label}</td><td style="padding:8px 12px;color:#111827;border-bottom:1px solid #e5e7eb;">${value}</td></tr>`,
    )
    .join("\n");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1e3a5f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:18px;">Fuel Release Request</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">Baker Aviation — ${opts.refCode}</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:20px;">
    <p style="margin:0 0 16px;font-size:14px;">
      Please confirm the following fuel release for Baker Aviation:
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${tableRows}
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">
      Please reply to this email to confirm or if you have any questions.<br>
      Reference: <strong>${opts.refCode}</strong>
    </p>
  </div>
  <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">
    Baker Aviation Operations &bull;
    <a href="mailto:operations@baker-aviation.com" style="color:#1e3a5f;">operations@baker-aviation.com</a>
  </p>
</body>
</html>`.trim();
}

export class EmailAdapter implements FuelVendorAdapter {
  readonly vendorId = "email" as const;
  readonly vendorName = "Email";
  readonly capabilities: VendorCapabilities = {
    realTimePricing: false,
    submitRelease: true,
    checkReleaseStatus: false,
    cancelRelease: false,
  };

  async getRealTimePrice(
    _req: RealTimePriceRequest,
  ): Promise<RealTimePriceResponse | null> {
    return null;
  }

  async submitFuelRelease(
    req: FuelReleaseRequest,
  ): Promise<FuelReleaseResponse> {
    // Look up the vendor from the DB to get contact email
    const supa = createServiceClient();

    // Try to find vendor by name match
    const { data: vendors } = await supa
      .from("fuel_vendors")
      .select("*")
      .eq("active", true)
      .order("name");

    // Match vendor by name (fuzzy)
    const vendorNameLower = (
      (req as FuelReleaseRequest & { vendorSlug?: string }).vendorSlug ??
      req.notes ??
      ""
    ).toLowerCase();

    let vendor = vendors?.find(
      (v) =>
        v.slug === vendorNameLower ||
        v.name.toLowerCase() === vendorNameLower,
    );

    // If no match from slug/notes, this is called from the submit route which
    // passes vendor info via the extended request. Fall back to first active email vendor.
    if (!vendor) {
      vendor = vendors?.find(
        (v) => v.release_type === "email" && v.contact_email,
      );
    }

    if (!vendor?.contact_email) {
      return {
        success: false,
        status: "failed",
        message: "No vendor email address found. Check vendor configuration.",
      };
    }

    // Generate ref code — we'll use a temp ID and update after DB insert
    const tempId = crypto.randomUUID();
    const refCode = makeRefCode(tempId);

    // Build destination from notes if vendor requires it
    const destination = vendor.requires_destination
      ? (req.notes ?? undefined)
      : undefined;

    const html = buildReleaseEmailHtml({
      tailNumber: req.tailNumber,
      airport: req.airport,
      fbo: req.fbo,
      gallons: req.gallons,
      date: req.date,
      refCode,
      vendorName: vendor.name,
      destination,
      notes: !vendor.requires_destination ? req.notes : undefined,
    });

    const subject = `Fuel Release Request — ${req.tailNumber} at ${strip(req.airport)} [${refCode}]`;

    const sendTo = req.toOverride || vendor.contact_email;

    const result = await sendGraphMail({
      to: sendTo,
      subject,
      html,
      cc: req.cc,
    });

    if (!result.success) {
      return {
        success: false,
        status: "failed",
        message: result.error ?? "Email send failed",
      };
    }

    const ccNote = req.cc?.length ? ` (cc: ${req.cc.join(", ")})` : "";
    return {
      success: true,
      status: "pending",
      vendorConfirmation: refCode,
      message: `Release email sent to ${sendTo}${ccNote}`,
    };
  }

  async getFuelReleaseStatus(
    _vendorConfirmation: string,
  ): Promise<FuelReleaseStatusResponse | null> {
    // Status is updated by the reply-processing cron, not polled
    return null;
  }

  async cancelFuelRelease(
    _vendorConfirmation: string,
  ): Promise<{ success: boolean; message?: string }> {
    // Could send a cancellation email in the future
    return {
      success: true,
      message: "Release marked as cancelled (no cancellation email sent)",
    };
  }
}
