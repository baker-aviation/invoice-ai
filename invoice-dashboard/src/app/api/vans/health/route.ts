import { NextResponse } from "next/server";

/**
 * Unauthenticated health check for Samsara API connectivity.
 * Returns whether the API key is configured and whether Samsara responds.
 * Does NOT return vehicle data, key material, or error details.
 */
export async function GET() {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "SAMSARA_API_KEY not configured", keyPresent: false });
  }

  try {
    const res = await fetch(
      "https://api.samsara.com/fleet/vehicles/stats?types=gps",
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      console.error(`[vans/health] Samsara API returned HTTP ${res.status}`);
      return NextResponse.json({ ok: false, error: "Samsara API error", keyPresent: true });
    }

    const json = await res.json();
    const count = (json.data ?? []).length;

    return NextResponse.json({ ok: true, vehicleCount: count, keyPresent: true });
  } catch (err) {
    console.error("[vans/health] Samsara API unreachable:", err);
    return NextResponse.json({ ok: false, error: "Samsara API unreachable", keyPresent: true });
  }
}
