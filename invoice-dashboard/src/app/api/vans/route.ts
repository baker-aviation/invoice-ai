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

  // Primary: GPS stats — paginate to ensure we get ALL vehicles
  const statsData: SamsaraVehicleStat[] = [];
  try {
    const statsBase = `${SAMSARA_BASE}/fleet/vehicles/stats?types=gps&limit=200`;
    let statsUrl: string | null = statsBase;
    let page = 0;
    while (statsUrl) {
      console.log(`[/api/vans] Fetching stats page ${page}: ${statsUrl}`);
      const resp: Response = await fetch(statsUrl, { headers, cache: "no-store" });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.error(`[/api/vans] Samsara stats error: HTTP ${resp.status} — ${errBody.slice(0, 500)}`);
        return NextResponse.json(
          { error: `Samsara API error: HTTP ${resp.status}`, detail: errBody.slice(0, 500) },
          { status: 502 },
        );
      }
      const payload: { data?: SamsaraVehicleStat[]; pagination?: { hasNextPage?: boolean; endCursor?: string } } = await resp.json();
      statsData.push(...(payload.data ?? []));
      if (payload.pagination?.hasNextPage && payload.pagination?.endCursor) {
        statsUrl = `${statsBase}&after=${encodeURIComponent(payload.pagination.endCursor)}`;
      } else {
        statsUrl = null;
      }
      page++;
      if (page > 10) break; // safety limit
    }
    console.log(`[/api/vans] Samsara returned ${statsData.length} vehicles from stats (${page} page(s))`);
  } catch (err) {
    console.error(`[/api/vans] Samsara fetch failed:`, err);
    return NextResponse.json(
      { error: "Samsara API unreachable" },
      { status: 502 },
    );
  }

  // Supplementary: vehicle locations for reverse-geocoded addresses
  // Also used as fallback for GPS data if stats endpoint returns sparse data
  const locationById = new Map<string, SamsaraLocation["location"]>();
  try {
    const locBase = `${SAMSARA_BASE}/fleet/vehicles/locations?limit=200`;
    let locUrl: string | null = locBase;
    while (locUrl) {
      const resp2: Response = await fetch(locUrl, { headers, cache: "no-store" });
      if (resp2.ok) {
        const payload2: { data?: SamsaraLocation[]; pagination?: { hasNextPage?: boolean; endCursor?: string } } = await resp2.json();
        for (const v of (payload2.data ?? [])) {
          if (v.id && v.location) locationById.set(v.id, v.location);
        }
        if (payload2.pagination?.hasNextPage && payload2.pagination?.endCursor) {
          locUrl = `${locBase}&after=${encodeURIComponent(payload2.pagination.endCursor)}`;
        } else {
          locUrl = null;
        }
      } else {
        console.warn(`[/api/vans] Samsara locations returned HTTP ${resp2.status}`);
        locUrl = null;
      }
    }
    console.log(`[/api/vans] Samsara returned ${locationById.size} vehicles from locations`);
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
