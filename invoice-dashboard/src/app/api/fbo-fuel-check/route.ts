import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { airportVariants, type BestRate } from "@/lib/fuelLookup";
import { calcPpg } from "@/app/tanker/model";

export const dynamic = "force-dynamic";

const FF_BASE = "https://public-api.foreflight.com/public/api";

function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

async function safeParseFF(res: Response): Promise<{ ok: boolean; data?: unknown; error?: string; status: number }> {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) return { ok: false, error: `ForeFlight ${res.status}: ${JSON.stringify(data)}`, status: res.status };
    return { ok: true, data, status: res.status };
  } catch {
    return { ok: false, error: `ForeFlight ${res.status}: ${text}`, status: res.status };
  }
}

type CruiseProfile = { uuid: string; profileName: string };

/** Fetch aircraft list from ForeFlight and find the cruise profile UUID matching a MACH target */
async function findCruiseProfile(
  registration: string,
  machTarget: string, // e.g. ".85" or ".78"
): Promise<{ uuid: string; profileName: string } | null> {
  const res = await fetch(`${FF_BASE}/aircraft`, {
    headers: { "x-api-key": apiKey() },
  });
  const parsed = await safeParseFF(res);
  if (!parsed.ok) return null;

  const list = Array.isArray(parsed.data) ? parsed.data : (parsed.data as Record<string, unknown>)?.aircraft ?? [];
  const ac = (list as Record<string, unknown>[]).find(
    (a) => (a.aircraftRegistration as string)?.toUpperCase() === registration.toUpperCase(),
  );
  if (!ac) return null;

  const profiles = (ac.cruiseProfiles ?? []) as CruiseProfile[];
  // Try exact MACH match first (e.g. "M.85", "MACH .85", ".85")
  const machNum = machTarget.replace(/^\./, "");
  const match = profiles.find((p) => {
    const name = p.profileName.toUpperCase();
    return name.includes(`.${machNum}`) || name.includes(`M${machNum}`) || name.includes(`MACH ${machTarget}`);
  });
  if (match) return match;

  // Fallback: "Long Range", then first profile
  const lrc = profiles.find((p) => /long.range/i.test(p.profileName));
  return lrc ?? profiles[0] ?? null;
}

/** Get FBO options at an airport from advertised prices, sorted cheapest first */
async function getFboOptions(airportCode: string): Promise<
  { vendor: string; fbo: string | null; price: number; volume_tier: string; product: string; week_start: string }[]
> {
  const prices = await fetchAdvertisedPrices({ recentWeeks: 4 });
  const variants = airportVariants(airportCode);

  // Filter to this airport, skip tail-specific rows
  const atAirport = prices.filter(
    (p) => variants.includes(p.airport_code.toUpperCase()) && !p.tail_numbers,
  );

  if (!atAirport.length) return [];

  // Find most recent week for this airport
  let latestWeek = "";
  for (const r of atAirport) {
    if (r.week_start > latestWeek) latestWeek = r.week_start;
  }

  // All options from latest week, sorted by price
  const currentWeek = atAirport.filter((r) => r.week_start === latestWeek);
  currentWeek.sort((a, b) => a.price - b.price);

  return currentWeek.map((r) => {
    const fboMatch = r.product.match(/\(([^)]+)\)/);
    return {
      vendor: r.fbo_vendor,
      fbo: fboMatch ? fboMatch[1] : null,
      price: r.price,
      volume_tier: r.volume_tier,
      product: r.product,
      week_start: r.week_start,
    };
  });
}

/** Recursively search for a key in a nested object */
function deepFind(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Extract normalized performance fields from a ForeFlight response */
function extractPerf(data: Record<string, unknown>) {
  const perf = (data.performance ?? deepFind(data, "performance")) as Record<string, unknown> | undefined;
  const fuel = (perf?.fuel ?? deepFind(data, "fuel")) as Record<string, number> | undefined;
  const times = (perf?.times ?? deepFind(data, "times")) as Record<string, unknown> | undefined;
  const distances = (perf?.distances ?? deepFind(data, "distances")) as Record<string, number> | undefined;
  const weather = (perf?.weather ?? deepFind(data, "weather")) as Record<string, number> | undefined;
  const weights = (perf?.weights ?? deepFind(data, "weights")) as Record<string, number> | undefined;

  const fuelToDestLbs = fuel?.fuelToDestination ?? 0;
  const totalFuelLbs = fuel?.totalFuel ?? 0;
  const ppg = calcPpg(15);
  return {
    fuel: {
      fuelToDestLbs: Math.round(fuelToDestLbs),
      fuelToDestGal: Math.round(fuelToDestLbs / ppg),
      totalFuelLbs: Math.round(totalFuelLbs),
      totalFuelGal: Math.round(totalFuelLbs / ppg),
      flightFuelLbs: Math.round(fuel?.flightFuel ?? 0),
      taxiFuelLbs: Math.round(fuel?.taxiFuel ?? 0),
      reserveFuelLbs: Math.round(fuel?.reserveFuel ?? 0),
      unit: fuel?.unit ?? "lbs",
      ppg,
    },
    times: {
      flightMinutes: times?.timeToDestinationMinutes ?? 0,
      totalMinutes: times?.totalTimeMinutes ?? 0,
      etaLocal: times?.estimatedArrivalTimeLocal ?? null,
    },
    distances: {
      routeNm: distances?.destination ?? 0,
      greatCircleNm: distances?.gcdDestination ?? 0,
    },
    weather: {
      windComponent: weather?.averageWindComponent ?? 0,
      windDirection: weather?.averageWindDirection ?? 0,
      windVelocity: weather?.averageWindVelocity ?? 0,
      isaDeviation: weather?.averageISADeviation ?? 0,
    },
    weights: weights ? {
      rampWeight: Math.round(weights.rampWeight ?? 0),
      takeOffWeight: Math.round(weights.takeOffWeight ?? 0),
      landingWeight: Math.round(weights.landingWeight ?? 0),
      zeroFuelWeight: Math.round(weights.zeroFuelWeight ?? 0),
    } : null,
    warnings: (perf?.warnings as string[]) ?? [],
    errors: (perf?.errors as string[]) ?? [],
  };
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const body = await req.json();
    const { departure, destination, aircraftType, altitudeOverride, cruiseProfileOverride, compare } = body as {
      departure: string;
      destination: string;
      aircraftType: "citation" | "challenger";
      altitudeOverride?: number;
      cruiseProfileOverride?: string;
      compare?: boolean;
    };

    if (!departure || !destination || !aircraftType) {
      return NextResponse.json(
        { error: "departure, destination, and aircraftType required" },
        { status: 400 },
      );
    }

    const config = aircraftType === "citation"
      ? { registration: "N106PC", mach: ".85", altitude: 470 }
      : { registration: "N520FX", mach: ".78", altitude: 470 };

    const altitude = altitudeOverride ?? config.altitude;

    // Fetch cruise profile and FBO options in parallel
    const [profile, fboOptions] = await Promise.all([
      findCruiseProfile(config.registration, config.mach),
      getFboOptions(destination.toUpperCase()),
    ]);

    const cruiseUUID = cruiseProfileOverride || profile?.uuid;

    // Build ForeFlight flight plan — let ForeFlight auto-route (don't set routeToDestination.route)
    const flightReq: Record<string, unknown> = {
      flight: {
        departure: departure.toUpperCase(),
        destination: destination.toUpperCase(),
        aircraftRegistration: config.registration,
        scheduledTimeOfDeparture: new Date(Date.now() + 3600_000).toISOString(),
        ...(cruiseUUID && { cruiseProfileUUID: cruiseUUID }),
        routeToDestination: {
          altitude: { altitude, unit: "FL" },
        },
        load: { people: 4 },
        windOptions: { windModel: "Forecasted" },
      },
    };

    // ─── Call ForeFlight: POST /Flights (creates temp flight, then deletes) ───
    const flightsRes = await fetch(`${FF_BASE}/Flights`, {
      method: "POST",
      headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify(flightReq),
    });

    const flightsParsed = await safeParseFF(flightsRes);
    if (!flightsParsed.ok) {
      return NextResponse.json(
        { error: flightsParsed.error, request: flightReq },
        { status: flightsParsed.status },
      );
    }

    const flightsData = flightsParsed.data as Record<string, unknown>;

    // Clean up the temp flight
    const flightId = flightsData.flightId as string | undefined;
    if (flightId) {
      fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
        method: "DELETE",
        headers: { "x-api-key": apiKey() },
      }).catch(() => {});
    }

    const flightsPerf = extractPerf(flightsData);

    // ─── Compare mode: also call POST /Flights/performance (no flight created) ───
    let performancePerf: ReturnType<typeof extractPerf> | null = null;
    let performanceRaw: unknown = null;
    let performanceError: string | null = null;

    if (compare) {
      const perfRes = await fetch(`${FF_BASE}/Flights/performance`, {
        method: "POST",
        headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
        body: JSON.stringify(flightReq),
      });
      const perfParsed = await safeParseFF(perfRes);
      if (perfParsed.ok) {
        const perfData = perfParsed.data as Record<string, unknown>;
        performancePerf = extractPerf(perfData);
        performanceRaw = perfData;
      } else {
        performanceError = perfParsed.error ?? `HTTP ${perfParsed.status}`;
      }
    }

    const fuelToDestGal = flightsPerf.fuel.fuelToDestLbs / flightsPerf.fuel.ppg;

    // Calculate cost for each FBO option
    const fboWithCost = fboOptions.map((fbo) => ({
      ...fbo,
      estimatedCost: Math.round(fuelToDestGal * fbo.price * 100) / 100,
    }));

    // Get available cruise profiles for expert mode
    const allProfiles = await (async () => {
      try {
        const r = await fetch(`${FF_BASE}/aircraft`, { headers: { "x-api-key": apiKey() } });
        const p = await safeParseFF(r);
        if (!p.ok) return [];
        const list = Array.isArray(p.data) ? p.data : (p.data as Record<string, unknown>)?.aircraft ?? [];
        const ac = (list as Record<string, unknown>[]).find(
          (a) => (a.aircraftRegistration as string)?.toUpperCase() === config.registration.toUpperCase(),
        );
        return (ac?.cruiseProfiles ?? []) as CruiseProfile[];
      } catch { return []; }
    })();

    return NextResponse.json({
      aircraft: {
        registration: config.registration,
        type: aircraftType,
        mach: config.mach,
        altitude: `FL${altitude}`,
        cruiseProfile: profile?.profileName ?? "Default",
        cruiseProfileUUID: cruiseUUID ?? null,
        availableProfiles: allProfiles,
      },
      route: {
        departure: departure.toUpperCase(),
        destination: destination.toUpperCase(),
      },
      ...flightsPerf,
      fboOptions: fboWithCost,
      _raw: flightsData,
      _request: flightReq,
      // Compare results (only present when compare=true)
      ...(compare && {
        comparison: {
          flights: {
            label: "POST /Flights (create + delete)",
            ...flightsPerf,
          },
          performance: performanceError
            ? { label: "POST /Flights/performance", error: performanceError }
            : {
                label: "POST /Flights/performance (no flight)",
                ...performancePerf,
                _raw: performanceRaw,
              },
        },
      }),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
