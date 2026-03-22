import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { searchFlights } from "@/lib/hasdata";
import type { FlightOffer } from "@/lib/amadeus";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RequestSchema = z.object({
  origin_iata: z.string().min(2).max(4),
  destination_iata: z.string().min(2).max(4),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strip();

// Simple in-memory rate limiter: 5 searches per minute per user
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

/**
 * POST /api/crew/flight-search
 *
 * Live flight search via HasData (Google Flights scraper).
 * Checks cache first (hasdata_flight_cache, <24h), then calls API if stale/missing.
 * Rate limited to 5 searches per minute per user.
 *
 * Body: { origin_iata, destination_iata, date }
 * Returns: { options: TransportOption[], cached: boolean }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  // Rate limit
  if (!checkRateLimit(auth.userId)) {
    return NextResponse.json(
      { error: "Rate limit exceeded — max 5 flight searches per minute" },
      { status: 429 },
    );
  }

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { origin_iata, destination_iata, date } = parsed.data;
  const supa = createServiceClient();

  // Check cache (< 24h old)
  const cacheThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: cached } = await supa
    .from("hasdata_flight_cache")
    .select("offers, fetched_at")
    .eq("origin_iata", origin_iata)
    .eq("destination_iata", destination_iata)
    .eq("cache_date", date)
    .gte("fetched_at", cacheThreshold)
    .maybeSingle();

  if (cached?.offers) {
    const offers = cached.offers as unknown as FlightOffer[];
    return NextResponse.json({
      options: offersToOptions(offers, origin_iata, destination_iata),
      cached: true,
      total: offers.length,
    });
  }

  // Cache miss or stale — call HasData live
  try {
    const result = await searchFlights({
      origin: origin_iata,
      destination: destination_iata,
      date,
      max: 15,
    });

    // Upsert to cache
    if (result.offers.length > 0) {
      await supa.from("hasdata_flight_cache").upsert(
        {
          origin_iata,
          destination_iata,
          cache_date: date,
          offers: result.offers as unknown as Record<string, unknown>[],
          offer_count: result.offers.length,
          has_direct: result.offers.some((o) => (o.itineraries[0]?.segments?.length ?? 0) <= 1),
          min_price: Math.min(...result.offers.map((o) => parseFloat(o.price.total)).filter((p) => !isNaN(p))),
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "origin_iata,destination_iata,cache_date" },
      );
    }

    return NextResponse.json({
      options: offersToOptions(result.offers, origin_iata, destination_iata),
      cached: false,
      total: result.offers.length,
    });
  } catch (e) {
    console.error(`[FlightSearch] HasData error:`, e);
    return NextResponse.json(
      { error: `Flight search failed: ${e instanceof Error ? e.message : "unknown"}` },
      { status: 502 },
    );
  }
}

// ─── Convert FlightOffers to simplified options ─────────────────────────────

function offersToOptions(
  offers: FlightOffer[],
  originIata: string,
  destinationIata: string,
) {
  return offers.map((offer) => {
    const segs = offer.itineraries[0]?.segments ?? [];
    const firstSeg = segs[0];
    const lastSeg = segs[segs.length - 1];
    const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
    const price = parseFloat(offer.price.total);
    const totalDuration = parseDuration(offer.itineraries[0]?.duration ?? "PT0M");

    return {
      type: "commercial" as const,
      flight_number: flightNum || null,
      origin_iata: firstSeg?.departure?.iataCode ?? originIata,
      destination_iata: lastSeg?.arrival?.iataCode ?? destinationIata,
      depart_at: firstSeg?.departure?.at ?? null,
      arrive_at: lastSeg?.arrival?.at ?? null,
      fbo_arrive_at: null, // Not computed here — client or transport-options API does this
      duty_on_at: null,
      cost_estimate: isNaN(price) ? 0 : Math.round(price),
      duration_minutes: totalDuration,
      is_direct: segs.length <= 1,
      connection_count: Math.max(0, segs.length - 1),
      has_backup: false,
      backup_flight: null,
      score: 50 + (segs.length <= 1 ? 12 : 3) + Math.max(0, 20 - Math.round(price / 25)),
      feasibility: {
        duty_hours: null,
        duty_ok: true,
        fbo_buffer_min: null,
        fbo_buffer_ok: true,
        midnight_ok: true,
      },
    };
  });
}

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0") * 60) + parseInt(m[2] ?? "0");
}
