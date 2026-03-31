import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";

const BASE = "https://aeroapi.flightaware.com/aeroapi";

function apiKey(): string {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) throw new Error("FLIGHTAWARE_API_KEY not set");
  return key;
}

function headers() {
  return { "x-apikey": apiKey(), Accept: "application/json; charset=UTF-8" };
}

type LocationResult = {
  airport_code: string;
  airport_name: string | null;
  city: string | null;
  state: string | null;
  last_seen: string | null;
};

/**
 * Look up the last known airport for a tail number by finding the most recent
 * landed flight in FlightAware. Tries N-number first (works for non-LADD aircraft),
 * then falls back to KOW callsign (Baker fleet convention).
 */
async function getLastKnownLocation(
  tail: string,
): Promise<LocationResult | null> {
  const idents = [tail];
  // Derive KOW callsign as fallback (e.g. N301HR → KOW301)
  const digits = tail.replace(/\D/g, "");
  if (digits) idents.push(`KOW${digits}`);

  for (const ident of idents) {
    try {
      const url = `${BASE}/flights/${encodeURIComponent(ident)}`;
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;

      const data = await res.json();
      const flights = (data.flights ?? []) as Array<{
        actual_in: string | null;
        actual_on: string | null;
        destination: {
          code: string | null;
          code_iata: string | null;
          name: string | null;
          city: string | null;
          state: string | null;
        } | null;
      }>;

      // Find the most recent completed flight (has actual gate-in or wheels-on)
      const landed = flights
        .filter((f) => f.actual_in || f.actual_on)
        .sort((a, b) =>
          (b.actual_in ?? b.actual_on ?? "").localeCompare(
            a.actual_in ?? a.actual_on ?? "",
          ),
        );

      if (landed.length > 0 && landed[0].destination) {
        const dest = landed[0].destination;
        return {
          airport_code:
            dest.code_iata ?? dest.code?.replace(/^K/, "") ?? "???",
          airport_name: dest.name,
          city: dest.city,
          state: dest.state,
          last_seen: landed[0].actual_in ?? landed[0].actual_on,
        };
      }
    } catch {
      // Timeout or network error — try next ident
    }
  }
  return null;
}

// ── POST — Batch location lookup ────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const { tail_numbers } = (await req.json()) as {
      tail_numbers: string[];
    };

    if (
      !Array.isArray(tail_numbers) ||
      tail_numbers.length === 0 ||
      tail_numbers.length > 50
    ) {
      return NextResponse.json(
        { error: "Provide 1-50 tail numbers" },
        { status: 400 },
      );
    }

    // Process in parallel batches of 5 to respect FA rate limits
    const locations: Record<string, LocationResult | null> = {};
    for (let i = 0; i < tail_numbers.length; i += 5) {
      const batch = tail_numbers.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (tail) => ({
          tail,
          location: await getLastKnownLocation(tail),
        })),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          locations[r.value.tail] = r.value.location;
        }
      }
    }

    return NextResponse.json({ locations });
  } catch (err) {
    console.error("[aircraft-tracker/locations]", err);
    return NextResponse.json(
      { error: "Failed to fetch locations" },
      { status: 500 },
    );
  }
}
