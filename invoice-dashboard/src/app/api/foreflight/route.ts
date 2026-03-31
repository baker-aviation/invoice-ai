import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const FF_BASE = "https://public-api.foreflight.com/public/api";

function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

const FLIGHT_SUB_RESOURCES: Record<string, string> = {
  briefing: "briefing",
  navlog: "navlog",
  performance: "performance",
  overflight: "overflight",
  rwa: "rwa",
  wb: "wb",
  icao: "icao",
};

/** Safely parse a ForeFlight response — they sometimes return text errors even on 200 */
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

/** GET /api/foreflight?action=aircraft — list aircraft */
/** GET /api/foreflight?action=flight&flightId=xxx — get flight details */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const action = req.nextUrl.searchParams.get("action");

  try {
    if (action === "aircraft") {
      const res = await fetch(`${FF_BASE}/aircraft`, {
        headers: { "x-api-key": apiKey() },
      });
      const parsed = await safeParseFF(res);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
      return NextResponse.json(parsed.data);
    }

    if (action === "flight") {
      const flightId = req.nextUrl.searchParams.get("flightId");
      if (!flightId) return NextResponse.json({ error: "flightId required" }, { status: 400 });
      const res = await fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
        headers: { "x-api-key": apiKey() },
      });
      const parsed = await safeParseFF(res);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
      return NextResponse.json(parsed.data);
    }

    if (action === "flights") {
      const url = new URL(`${FF_BASE}/Flights/flights`);
      const fromDate = req.nextUrl.searchParams.get("fromDate");
      const toDate = req.nextUrl.searchParams.get("toDate");
      const search = req.nextUrl.searchParams.get("search");
      const tags = req.nextUrl.searchParams.get("tags");
      if (fromDate) url.searchParams.set("fromDate", fromDate);
      if (toDate) url.searchParams.set("toDate", toDate);
      if (search) url.searchParams.set("search", search);
      if (tags) url.searchParams.set("tags", tags);
      const res = await fetch(url.toString(), {
        headers: { "x-api-key": apiKey() },
      });
      const parsed = await safeParseFF(res);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
      return NextResponse.json(parsed.data);
    }

    if (action === "flightDetail") {
      const flightId = req.nextUrl.searchParams.get("flightId");
      if (!flightId) return NextResponse.json({ error: "flightId required" }, { status: 400 });
      const res = await fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
        headers: { "x-api-key": apiKey() },
      });
      const parsed = await safeParseFF(res);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
      return NextResponse.json(parsed.data);
    }

    if (action && action in FLIGHT_SUB_RESOURCES) {
      const flightId = req.nextUrl.searchParams.get("flightId");
      if (!flightId) return NextResponse.json({ error: "flightId required" }, { status: 400 });
      const sub = FLIGHT_SUB_RESOURCES[action];
      const res = await fetch(
        `${FF_BASE}/Flights/${encodeURIComponent(flightId)}/${sub}`,
        { headers: { "x-api-key": apiKey() } },
      );
      const parsed = await safeParseFF(res);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
      return NextResponse.json(parsed.data);
    }

    return NextResponse.json({ error: "action required: aircraft | flight | flights | flightDetail | briefing | navlog | performance | overflight | rwa | wb | icao" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/foreflight — two modes:
 *   - Default (no action): create temp flight for fuel calc, then auto-delete
 *   - ?action=create: push a real flight to ForeFlight dispatch (keeps it)
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const action = req.nextUrl.searchParams.get("action");

  try {
    const body = await req.json();

    // ─── action=create: push full flight to ForeFlight dispatch ───
    if (action === "create") {
      const { flight } = body;
      if (!flight?.departure || !flight?.destination || !flight?.aircraftRegistration || !flight?.scheduledTimeOfDeparture) {
        return NextResponse.json(
          { error: "flight.departure, destination, aircraftRegistration, and scheduledTimeOfDeparture required" },
          { status: 400 },
        );
      }

      const flightReq = { flight };
      const res = await fetch(`${FF_BASE}/Flights`, {
        method: "POST",
        headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
        body: JSON.stringify(flightReq),
      });

      const parsed = await safeParseFF(res);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error, request: flightReq }, { status: parsed.status });
      }

      return NextResponse.json(parsed.data);
    }

    // ─── Default: temp flight for fuel calc (auto-deletes) ───
    const {
      departure,
      destination,
      aircraftRegistration,
      cruiseProfileUUID,
      alternate,
      route,
      altitude,
      people,
      cargo,
    } = body;

    if (!departure || !destination || !aircraftRegistration) {
      return NextResponse.json(
        { error: "departure, destination, and aircraftRegistration required" },
        { status: 400 },
      );
    }

    const flightReq: Record<string, unknown> = {
      flight: {
        departure,
        destination,
        aircraftRegistration,
        scheduledTimeOfDeparture: new Date(Date.now() + 3600_000).toISOString(),
        ...(cruiseProfileUUID && { cruiseProfileUUID }),
        ...(alternate && { alternate }),
        ...(route && {
          routeToDestination: {
            route,
            ...(altitude && { altitude: { altitude: Number(altitude), unit: "FL" } }),
          },
        }),
        ...((!route && altitude) && {
          routeToDestination: {
            altitude: { altitude: Number(altitude), unit: "FL" },
          },
        }),
        ...((people || cargo) && {
          load: {
            ...(people && { people: Number(people) }),
            ...(cargo && { cargo: Number(cargo) }),
          },
        }),
        windOptions: {
          windModel: "Forecasted",
        },
      },
    };

    const res = await fetch(`${FF_BASE}/Flights`, {
      method: "POST",
      headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify(flightReq),
    });

    const parsed = await safeParseFF(res);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, request: flightReq }, { status: parsed.status });
    }
    const data = parsed.data as Record<string, unknown>;

    const flightId = data.flightId as string | undefined;
    if (flightId) {
      fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
        method: "DELETE",
        headers: { "x-api-key": apiKey() },
      }).catch(() => {});
    }

    return NextResponse.json({ ...data, _request: flightReq });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
