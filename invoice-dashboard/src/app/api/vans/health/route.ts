import { NextResponse } from "next/server";

/**
 * Unauthenticated health check for Samsara API connectivity.
 * Returns whether the API key is configured and whether Samsara responds.
 * Does NOT return vehicle data — just connection status.
 */
export async function GET() {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: "SAMSARA_API_KEY not set in environment",
      keyPresent: false,
    });
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
      const body = await res.text().catch(() => "");
      return NextResponse.json({
        ok: false,
        error: `Samsara API returned HTTP ${res.status}`,
        detail: body.slice(0, 500),
        keyPresent: true,
        keyPrefix: apiKey.slice(0, 8) + "…",
      });
    }

    const json = await res.json();
    const count = (json.data ?? []).length;

    return NextResponse.json({
      ok: true,
      vehicleCount: count,
      keyPresent: true,
      keyPrefix: apiKey.slice(0, 8) + "…",
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: "Samsara API unreachable",
      detail: String(err),
      keyPresent: true,
      keyPrefix: apiKey.slice(0, 8) + "…",
    });
  }
}
