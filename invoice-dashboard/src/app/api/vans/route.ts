import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

// Call Samsara API directly (avoids Cloud Run IAM auth issues)
const SAMSARA_BASE = "https://api.samsara.com";

interface SamsaraGps {
  latitude?: number;
  longitude?: number;
  speedMilesPerHour?: number;
  headingDegrees?: number;
  reverseGeo?: { formattedLocation?: string };
  time?: string;
}

interface SamsaraVehicleStat {
  id?: string;
  name?: string;
  gps?: SamsaraGps;
}

interface SamsaraLocation {
  id?: string;
  name?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    reverseGeo?: { formattedLocation?: string };
    time?: string;
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) {
    console.error("[/api/vans] SAMSARA_API_KEY not set in environment");
    return NextResponse.json(
      { error: "SAMSARA_API_KEY not configured" },
      { status: 503 },
    );
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  // Primary: GPS stats
  let statsData: SamsaraVehicleStat[];
  try {
    const url = `${SAMSARA_BASE}/fleet/vehicles/stats?types=gps`;
    console.log(`[/api/vans] Fetching ${url}`);
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[/api/vans] Samsara stats error: HTTP ${res.status} — ${body.slice(0, 500)}`);
      return NextResponse.json(
        { error: `Samsara API error: HTTP ${res.status}`, detail: body.slice(0, 500) },
        { status: 502 },
      );
    }
    const json = await res.json();
    statsData = (json.data ?? []) as SamsaraVehicleStat[];
    console.log(`[/api/vans] Samsara returned ${statsData.length} vehicles from stats`);
  } catch (err) {
    console.error(`[/api/vans] Samsara fetch failed:`, err);
    return NextResponse.json(
      { error: "Samsara API unreachable", detail: String(err) },
      { status: 502 },
    );
  }

  // Supplementary: vehicle locations for reverse-geocoded addresses
  // Also used as fallback for GPS data if stats endpoint returns sparse data
  const locationById = new Map<string, SamsaraLocation["location"]>();
  try {
    const res2 = await fetch(
      `${SAMSARA_BASE}/fleet/vehicles/locations`,
      { headers, cache: "no-store" },
    );
    if (res2.ok) {
      const json2 = await res2.json();
      for (const v of (json2.data ?? []) as SamsaraLocation[]) {
        if (v.id && v.location) locationById.set(v.id, v.location);
      }
      console.log(`[/api/vans] Samsara returned ${locationById.size} vehicles from locations`);
    } else {
      console.warn(`[/api/vans] Samsara locations returned HTTP ${res2.status}`);
    }
  } catch (err) {
    console.warn(`[/api/vans] Samsara locations fetch failed (non-fatal):`, err);
  }

  // Build response — merge stats GPS with locations fallback
  const vans = statsData.map((v) => {
    const gps = v.gps ?? {};
    const vid = v.id ?? "";
    const loc = locationById.get(vid);

    // Use stats GPS first, fall back to locations endpoint
    const lat = gps.latitude ?? loc?.latitude ?? null;
    const lon = gps.longitude ?? loc?.longitude ?? null;
    const address =
      loc?.reverseGeo?.formattedLocation ??
      gps.reverseGeo?.formattedLocation ??
      null;

    return {
      id: vid,
      name: v.name ?? null,
      lat,
      lon,
      speed_mph: gps.speedMilesPerHour ?? null,
      heading: gps.headingDegrees ?? null,
      address,
      gps_time: gps.time ?? loc?.time ?? null,
    };
  });

  return NextResponse.json({ ok: true, vans, count: vans.length });
}
