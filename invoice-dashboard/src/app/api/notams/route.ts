import { NextRequest, NextResponse } from "next/server";

// Proxy NOTAM lookups to aviationweather.gov (no auth required).
// Endpoint: GET /api/notams?airports=KTEB,KOPF
//
// This is the "no FAA credentials" path. Once ops-monitor's check_notams
// has FAA API credentials confirmed, the maintenance tab also shows those
// NOTAMs via the /api/flights data (already attached to flight alerts).

type AwcNotam = {
  icaoId?: string;
  notamNumber?: string;
  text?: string;
  startDate?: string;
  endDate?: string;
  type?: string;
  [key: string]: unknown;
};

type NotamResult = {
  icaoId?: string;
  notamNumber?: string;
  text: string;
  startDate?: string;
  endDate?: string;
};

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("airports") ?? "";
  if (!raw.trim()) {
    return NextResponse.json({ ok: true, notams: [] });
  }

  const icaos = raw
    .split(",")
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 10);

  try {
    // aviationweather.gov public NOTAM API — no authentication required
    const url =
      `https://aviationweather.gov/api/data/notam` +
      `?ids=${icaos.join(",")}&format=json&type=airport`;

    const res = await fetch(url, {
      headers: { "User-Agent": "baker-aviation-dashboard/1.0" },
      next: { revalidate: 300 }, // cache 5 min
    });

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, notams: [], error: `AWC API returned ${res.status}` },
        { status: 502 },
      );
    }

    const data: unknown = await res.json();

    // AWC returns a JSON array of NOTAM objects
    const raw_notams: AwcNotam[] = Array.isArray(data) ? (data as AwcNotam[]) : [];

    const notams: NotamResult[] = raw_notams
      .map((n) => ({
        icaoId:      n.icaoId,
        notamNumber: n.notamNumber,
        text:        (n.text ?? "").trim() || "No text",
        startDate:   n.startDate,
        endDate:     n.endDate,
      }))
      .filter((n) => n.text && n.text !== "No text" || n.notamNumber);

    return NextResponse.json({ ok: true, notams, source: "aviationweather.gov" });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, notams: [], error: String(err) },
      { status: 502 },
    );
  }
}
