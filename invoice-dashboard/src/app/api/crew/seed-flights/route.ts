import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { computeCityPairMatrix, seedTargetedPairs } from "@/lib/hasdataCache";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — same as cron

const RequestSchema = z.object({
  swap_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "swap_date must be YYYY-MM-DD"),
  tails: z.array(z.string()).optional(),
  mode: z.enum(["seed", "fill"]).default("fill"),
}).strip();

/**
 * POST /api/crew/seed-flights
 *
 * On-demand flight cache seeding for a specific swap date.
 * Computes city-pair matrix and seeds via HasData (Google Flights scraper).
 *
 * Body: { swap_date: string, tails?: string[], mode?: "seed" | "fill" }
 *   - swap_date: YYYY-MM-DD (required)
 *   - tails: optional tail filter (currently unused — pair computation is fast, cost is in API calls)
 *   - mode: "seed" = fetch all pairs, "fill" = skip pairs with offer_count > 0
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { swap_date, mode } = parsed.data;

  console.log(`[SeedFlights] ${auth.email} triggered ${mode} seed for ${swap_date}`);

  try {
    // Compute full city-pair matrix (fast — just DB queries)
    const basePairs = await computeCityPairMatrix(swap_date);

    // Seed both swap day and next day (optimizer searches next-day for offgoing)
    const nextDay = new Date(swap_date);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().slice(0, 10);
    const datesToSeed = [swap_date, nextDayStr];

    const swapDayPairs = basePairs.map((p) => ({ ...p, date: swap_date }));
    const nextDayPairs = basePairs.map((p) => ({ ...p, date: nextDayStr }));
    let allPairs = [...swapDayPairs, ...nextDayPairs];

    console.log(`[SeedFlights] ${allPairs.length} total pairs (${basePairs.length} x 2 days)`);

    // Fill mode: skip pairs that already have flights cached
    if (mode === "fill") {
      const supa = createServiceClient();
      const cachedWithFlights = new Set<string>();
      for (const d of datesToSeed) {
        const { data: existing } = await supa
          .from("hasdata_flight_cache")
          .select("origin_iata, destination_iata, offer_count")
          .eq("cache_date", d);
        for (const r of existing ?? []) {
          if ((r.offer_count as number) > 0) {
            cachedWithFlights.add(`${r.origin_iata}-${r.destination_iata}-${d}`);
          }
        }
      }
      const before = allPairs.length;
      allPairs = allPairs.filter((p) => !cachedWithFlights.has(`${p.origin}-${p.destination}-${p.date}`));
      console.log(`[SeedFlights] Fill mode: ${allPairs.length} pairs to fetch (${before - allPairs.length} already have flights)`);

      if (allPairs.length === 0) {
        return NextResponse.json({
          ok: true,
          swap_date,
          mode,
          pairs_queried: 0,
          offers_cached: 0,
          errors: [],
          duration_ms: 0,
          message: "Cache is already complete — nothing to fetch",
        });
      }
    }

    // Seed with conservative batch size (25) for on-demand requests
    const result = await seedTargetedPairs(allPairs);

    return NextResponse.json({
      ok: true,
      swap_date,
      mode,
      ...result,
    });
  } catch (e) {
    console.error("[SeedFlights] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Seed failed" },
      { status: 500 },
    );
  }
}
