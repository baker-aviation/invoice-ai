import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { listSheets, getSheetData } from "@/lib/googleSheets";
import { batchGetCommercialStatus, type CommercialFlightStatus } from "@/lib/flightaware";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";

// Build a fast lookup: FBO IATA → Set of commercial IATA alternatives
const _fboToCommercial = new Map<string, Set<string>>();
for (const a of DEFAULT_AIRPORT_ALIASES) {
  const fbo = a.fbo_icao.replace(/^K/, "").toUpperCase();
  const comm = a.commercial_icao.replace(/^K/, "").toUpperCase();
  if (!_fboToCommercial.has(fbo)) _fboToCommercial.set(fbo, new Set([fbo]));
  _fboToCommercial.get(fbo)!.add(comm);
}

/** Get all commercial IATA codes that serve a given FBO/airport */
function commercialAlternatives(airportIata: string): Set<string> {
  const upper = airportIata.toUpperCase();
  return _fboToCommercial.get(upper) ?? new Set([upper]);
}

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — may need to query ~100 flights at 1/sec

// ── In-memory cache ─────────────────────────────────────────────────────────
// Sheet data changes rarely on swap day → cache 10 min
// FlightAware live status changes frequently → cache 2 min
const SHEET_CACHE_MS = 10 * 60 * 1000; // 10 min
const LIVE_CACHE_MS = 2 * 60 * 1000;   // 2 min

type CacheEntry<T> = { data: T; timestamp: number };
let sheetCache: CacheEntry<{ tab: string; oncoming: CrewTravel[]; offgoing: CrewTravel[]; swapDate: string; faTotal: number }> | null = null;
let liveCache: CacheEntry<{ oncoming: CrewTravel[]; offgoing: CrewTravel[]; faResolved: number }> | null = null;

type LegDetail = {
  flight_number: string;
  status: string; // "Scheduled" | "Departed" | "En Route" | "Landed" | "Arrived"
  delay_minutes: number | null;
  origin: string; // IATA (from ICAO)
  destination: string; // IATA (from ICAO)
  scheduled_departure: string | null; // ISO
  actual_departure: string | null; // ISO
  estimated_arrival: string | null; // ISO
  actual_arrival: string | null; // ISO
};

type CrewTravel = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;
  tail_number: string;
  swap_location: string;
  transport_type: "commercial" | "uber" | "rental" | "brightline" | "staying" | "standby" | "unknown";
  flight_number: string | null;
  flight_numbers: string[];
  date: string | null;
  duty_on: string | null;
  arrival_time: string | null;
  price: string | null;
  notes: string | null;
  is_early_volunteer: boolean;
  is_skillbridge: boolean;
  is_checkairman: boolean;
  verified_ticket: boolean;
  home_airports: string[];
  status: "scheduled" | "boarding" | "departed" | "en_route" | "landed" | "arrived_fbo" | "delayed" | "cancelled" | "unknown";
  status_detail: string | null;
  live_departure: string | null;
  live_arrival: string | null;
  delay_minutes: number | null;
  leg_details: LegDetail[];
  connection_at_risk: boolean;
};

const EMOJI_TYPE: Record<string, string> = {
  "🟢": "citation_x",
  "🟡": "challenger",
  "🟣": "dual",
};

function parseTransportType(flightNum: string | null, notes: string | null): CrewTravel["transport_type"] {
  if (!flightNum) return "unknown";
  const fn = flightNum.trim().toLowerCase();
  if (fn === "uber" || fn.includes("uber")) return "uber";
  if (fn === "rental" || fn.includes("rental")) return "rental";
  if (fn.includes("brightline")) return "brightline";
  if (fn === "staying on" || fn.includes("staying")) return "staying";
  // Check notes for standby
  if (notes?.toUpperCase().includes("STANDBY")) return "standby";
  // If it has letters + numbers, likely a flight number
  if (/[A-Z]{1,3}\d+/i.test(fn)) return "commercial";
  return "unknown";
}

function parseFlightNumbers(raw: string | null): string[] {
  if (!raw) return [];
  // Split on "/" for connections: "UA1232/UA5369" → ["UA1232", "UA5369"]
  // Also handle "DL2216/DL1271", "AA5904/AA1419"
  return raw.split(/[\/,]/)
    .map(s => s.trim())
    .filter(s => /^[A-Z]{1,3}\d+/i.test(s));
}

function parseCrewCell(raw: string): { name: string; aircraft_type: string; home_airports: string[]; is_checkairman: boolean } | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let aircraft_type = "unknown";
  for (const [emoji, type] of Object.entries(EMOJI_TYPE)) {
    if (trimmed.includes(emoji)) { aircraft_type = type; break; }
  }

  const is_checkairman = /[✔✓]/.test(trimmed);
  const cleaned = trimmed
    .replace(/^[\u{1F7E0}-\u{1F7FF}\s]+/u, "")
    .replace(/[✔✓\s]+$/u, "")
    .trim();

  const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return null;

  const name = match[1].trim();
  const home_airports = match[2].split(/[\/,]/).map(a => a.trim().toUpperCase()).filter(a => a.length >= 2 && a.length <= 5);

  return { name, aircraft_type, home_airports, is_checkairman };
}

function guessStatus(crew: CrewTravel): CrewTravel["status"] {
  // Simple time-based guess (will be replaced by real flight status API later)
  if (crew.transport_type === "standby") return "unknown";
  if (crew.transport_type === "staying") return "arrived_fbo";
  if (!crew.date) return "unknown";

  // For today's flights, estimate based on current time vs scheduled times
  const now = new Date();
  const today = now.toLocaleDateString("en-CA"); // YYYY-MM-DD

  // Parse date like "3/25" or "3/24"
  const dateMatch = crew.date.match(/(\d{1,2})\/(\d{1,2})/);
  if (!dateMatch) return "scheduled";
  const crewDate = `2026-${dateMatch[1].padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}`;

  if (crewDate < today) {
    // Yesterday's travel — should be arrived
    return "arrived_fbo";
  }
  if (crewDate > today) {
    return "scheduled";
  }

  // Today — estimate from times
  if (!crew.arrival_time) return "scheduled";
  const arrMatch = crew.arrival_time.match(/^(\d{2})(\d{2})/);
  if (!arrMatch) return "scheduled";
  const arrHour = parseInt(arrMatch[1]);
  const arrMin = parseInt(arrMatch[2]);

  // Very rough: current hour in ET
  const etHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const etMin = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", minute: "numeric" }));
  const nowMinutes = etHour * 60 + etMin;
  const arrMinutes = arrHour * 60 + arrMin;

  if (nowMinutes > arrMinutes + 60) return "arrived_fbo"; // >1hr after arrival → at FBO
  if (nowMinutes > arrMinutes) return "landed";
  if (nowMinutes > arrMinutes - 120) return "en_route"; // within 2hr of arrival
  if (crew.duty_on) {
    const dutyMatch = crew.duty_on.match(/^(\d{2})(\d{2})/);
    if (dutyMatch) {
      const dutyMinutes = parseInt(dutyMatch[1]) * 60 + parseInt(dutyMatch[2]);
      if (nowMinutes > dutyMinutes) return "departed";
    }
  }
  return "scheduled";
}

export async function GET(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  // ?live=true enables FlightAware enrichment (separate call to avoid timeout)
  const live = req.nextUrl.searchParams.get("live") === "true";
  // ?tab=... overrides auto-detection (e.g., ?tab=FREEZE APR 1-APR 8 (B))
  const tabOverride = req.nextUrl.searchParams.get("tab");
  // ?refresh=true forces cache bypass
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";

  try {
    // ── Check live cache (FlightAware enriched) ──
    if (live && !forceRefresh && !tabOverride && liveCache && (Date.now() - liveCache.timestamp < LIVE_CACHE_MS) && sheetCache) {
      return NextResponse.json({
        swap_date: sheetCache.data.swapDate,
        sheet_name: sheetCache.data.tab,
        oncoming: liveCache.data.oncoming,
        offgoing: liveCache.data.offgoing,
        fa_flights_resolved: liveCache.data.faResolved,
        fa_flights_total: sheetCache.data.faTotal,
        last_updated: new Date(liveCache.timestamp).toISOString(),
        cached: true,
      });
    }

    // ── Check sheet cache (no live enrichment) ──
    if (!live && !forceRefresh && !tabOverride && sheetCache && (Date.now() - sheetCache.timestamp < SHEET_CACHE_MS)) {
      // Re-run guessStatus since time has passed
      const oncoming = sheetCache.data.oncoming.map(c => ({ ...c, status: guessStatus(c) }));
      const offgoing = sheetCache.data.offgoing.map(c => ({ ...c, status: guessStatus(c) }));
      return NextResponse.json({
        swap_date: sheetCache.data.swapDate,
        sheet_name: sheetCache.data.tab,
        oncoming,
        offgoing,
        fa_flights_resolved: null,
        fa_flights_total: sheetCache.data.faTotal,
        last_updated: new Date(sheetCache.timestamp).toISOString(),
        cached: true,
      });
    }

    const sheets = await listSheets();
    const sheetNames = sheets.map(s => s.title);

    let targetSheet: string | null = null;

    if (tabOverride) {
      // User explicitly selected a tab
      targetSheet = sheetNames.find(s => s === tabOverride) ?? null;
    } else {
      // Auto-detect: prefer FREEZE tab for current swap period, then weekly tabs
      // FREEZE tabs are finalized plans — always prefer over draft weekly sheets
      const freezeSheets = sheetNames.filter(n => /^FREEZE\b/i.test(n));
      if (freezeSheets.length > 0) {
        targetSheet = freezeSheets[0]; // Most recent FREEZE tab
      }
      if (!targetSheet) {
        // Fall back to weekly sheets — find most recent
        const weeklySheets = sheetNames.filter(n =>
          /^[A-Z]{3}\s+\d+-[A-Z]{3}\s+\d+\s*\([AB]\)$/i.test(n)
        );
        targetSheet = weeklySheets[0] ?? null;
      }
    }

    if (!targetSheet) {
      return NextResponse.json({ error: "No swap sheet found" }, { status: 404 });
    }

    const rows = await getSheetData(targetSheet);
    const oncoming: CrewTravel[] = [];
    const offgoing: CrewTravel[] = [];

    let inOncoming = true;
    let currentRole: "PIC" | "SIC" = "PIC";

    for (const row of rows) {
      const col2 = String(row[2] ?? "").trim();
      const col2Upper = col2.toUpperCase();

      if (col2Upper === "ONCOMING PILOTS" || col2Upper === "PILOT IN COMMAND") { inOncoming = true; currentRole = "PIC"; continue; }
      if (col2Upper === "OFFGOING PILOTS") { inOncoming = false; continue; }
      if (col2Upper === "PILOT IN-COMMAND" || col2Upper.includes("PILOT IN")) { currentRole = "PIC"; continue; }
      if (col2Upper === "SECOND IN-COMMAND" || col2Upper.includes("SECOND IN")) { currentRole = "SIC"; continue; }
      if (col2Upper.startsWith("NAME (HOME") || col2Upper === "SKILLBRIDGE" || !col2) continue;

      const parsed = parseCrewCell(col2);
      if (!parsed) continue;

      const flightRaw = String(row[5] ?? "").trim() || null;
      const notes = String(row[10] ?? "").trim() || null;
      const transport_type = parseTransportType(flightRaw, notes);

      // Skip empty standby entries with no tail
      const tail = String(row[4] ?? "").trim();
      if (!tail && transport_type !== "standby" && !notes?.toUpperCase().includes("STANDBY")) continue;

      const entry: CrewTravel = {
        name: parsed.name,
        role: currentRole,
        direction: inOncoming ? "oncoming" : "offgoing",
        aircraft_type: parsed.aircraft_type,
        tail_number: tail,
        swap_location: String(row[3] ?? "").trim(),
        transport_type,
        flight_number: flightRaw,
        flight_numbers: transport_type === "commercial" ? parseFlightNumbers(flightRaw) : [],
        date: String(row[6] ?? "").trim() || null,
        duty_on: String(row[7] ?? "").trim() || null,
        arrival_time: String(row[8] ?? "").trim() || null,
        price: String(row[9] ?? "").trim() || null,
        notes,
        is_early_volunteer: String(row[1] ?? "").trim().toUpperCase() === "E",
        is_skillbridge: String(row[0] ?? "").trim().toUpperCase() === "TRUE",
        is_checkairman: parsed.is_checkairman,
        verified_ticket: String(row[11] ?? "").trim().toUpperCase() === "TRUE",
        home_airports: parsed.home_airports,
        status: "scheduled",
        status_detail: null,
        live_departure: null,
        live_arrival: null,
        delay_minutes: null,
        leg_details: [],
        connection_at_risk: false,
      };

      // Guess status based on time
      entry.status = guessStatus(entry);

      // Standby crew
      if (notes?.toUpperCase().includes("STANDBY") && !tail) {
        entry.transport_type = "standby";
        entry.status = "unknown";
      }

      if (inOncoming) {
        oncoming.push(entry);
      } else {
        offgoing.push(entry);
      }
    }

    // Extract swap date from sheet name: "MAR 25-APR 1 (A)" → "2026-03-25"
    const dateMatch = targetSheet.match(/([A-Z]{3})\s+(\d+)/i);
    const monthMap: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
    const swapDate = dateMatch
      ? `2026-${monthMap[dateMatch[1].toUpperCase()] ?? "01"}-${dateMatch[2].padStart(2, "0")}`
      : new Date().toISOString().slice(0, 10);

    // ── Collect commercial flight legs ────────────────────────────────────
    const allCrew = [...oncoming, ...offgoing];
    const commercialFlightLegs = new Set<string>();
    for (const crew of allCrew) {
      if (crew.transport_type === "commercial") {
        for (const fn of crew.flight_numbers) commercialFlightLegs.add(fn);
      }
    }

    // Save sheet data to cache (before live enrichment mutates the entries)
    if (!tabOverride) {
      sheetCache = {
        data: {
          tab: targetSheet,
          oncoming: oncoming.map(c => ({ ...c })),
          offgoing: offgoing.map(c => ({ ...c })),
          swapDate,
          faTotal: commercialFlightLegs.size,
        },
        timestamp: Date.now(),
      };
    }

    // Without ?live=true, return sheet data with time-based status guesses only
    if (!live) {
      return NextResponse.json({
        swap_date: swapDate,
        sheet_name: targetSheet,
        oncoming,
        offgoing,
        fa_flights_resolved: null,
        fa_flights_total: commercialFlightLegs.size,
        last_updated: new Date().toISOString(),
      });
    }

    // ── FlightAware live enrichment ──────────────────────────────────────
    // Determine which date each flight is on (some crew travel day before: 3/24)
    // Group flights by their travel date for the FA query
    const flightsByDate = new Map<string, string[]>();
    for (const crew of allCrew) {
      if (crew.transport_type !== "commercial") continue;
      let flightDate = swapDate; // default to swap date
      if (crew.date) {
        const dm = crew.date.match(/(\d{1,2})\/(\d{1,2})/);
        if (dm) flightDate = `2026-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}`;
      }
      for (const fn of crew.flight_numbers) {
        if (!flightsByDate.has(flightDate)) flightsByDate.set(flightDate, []);
        flightsByDate.get(flightDate)!.push(fn);
      }
    }

    // Build origin hints to disambiguate same-number routes.
    // AA1033 can operate DFW→ORD and ORD→BOS on the same day.
    // Use crew context (swap_location, home_airports) + airport aliases
    // to figure out which airport each leg should depart from.
    const originHints = new Map<string, string>(); // flightNumber → expected origin IATA

    // Pre-build hints from crew context
    for (const crew of allCrew) {
      if (crew.transport_type !== "commercial" || crew.flight_numbers.length === 0) continue;
      const swapAlts = commercialAlternatives(crew.swap_location);
      const homeAlts = crew.home_airports.length > 0
        ? commercialAlternatives(crew.home_airports[0])
        : new Set<string>();

      if (crew.direction === "offgoing") {
        // Offgoing: first leg departs from swap area
        // Pick the preferred commercial airport for the swap location
        const preferred = [...swapAlts][0];
        if (preferred && !originHints.has(crew.flight_numbers[0])) {
          originHints.set(crew.flight_numbers[0], preferred);
        }
      } else {
        // Oncoming: first leg departs from home area
        const preferred = [...homeAlts][0];
        if (preferred && !originHints.has(crew.flight_numbers[0])) {
          originHints.set(crew.flight_numbers[0], preferred);
        }
      }
    }

    // Fetch live status from FlightAware (skip if no commercial flights)
    let faStatusMap = new Map<string, CommercialFlightStatus>();
    if (commercialFlightLegs.size > 0) {
      try {
        // First pass: fetch all flights with context-based origin hints
        for (const [date, flights] of flightsByDate) {
          const dateResults = await batchGetCommercialStatus(flights, date, originHints);
          for (const [fn, status] of dateResults) {
            faStatusMap.set(fn, status);
          }
        }

        // Second pass: for connections, use first leg's actual destination
        // as second leg's origin (more precise than alias-based hints)
        const needsRefetch: { fn: string; date: string; origin: string }[] = [];
        for (const crew of allCrew) {
          if (crew.flight_numbers.length < 2) continue;
          for (let i = 1; i < crew.flight_numbers.length; i++) {
            const prevFa = faStatusMap.get(crew.flight_numbers[i - 1]);
            const currFn = crew.flight_numbers[i];
            if (prevFa?.destination_iata) {
              // Check if current result's origin matches the connection
              const currFa = faStatusMap.get(currFn);
              if (currFa && currFa.origin_iata && currFa.origin_iata !== prevFa.destination_iata) {
                originHints.set(currFn, prevFa.destination_iata);
                let flightDate = swapDate;
                if (crew.date) {
                  const dm = crew.date.match(/(\d{1,2})\/(\d{1,2})/);
                  if (dm) flightDate = `2026-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}`;
                }
                needsRefetch.push({ fn: currFn, date: flightDate, origin: prevFa.destination_iata });
              } else if (!currFa) {
                // Not yet fetched — add hint for future fetch
                originHints.set(currFn, prevFa.destination_iata);
              }
            }
          }
        }

        // Re-fetch mismatched connections with precise origin from first leg
        if (needsRefetch.length > 0) {
          console.log(`[SwapStatus] Re-fetching ${needsRefetch.length} connection legs with origin hints`);
          for (const { fn, date, origin } of needsRefetch) {
            const hintsMap = new Map([[fn, origin]]);
            const results = await batchGetCommercialStatus([fn], date, hintsMap);
            for (const [key, status] of results) {
              faStatusMap.set(key, status);
            }
          }
        }

        console.log(`[SwapStatus] FA enrichment: ${faStatusMap.size}/${commercialFlightLegs.size} flights resolved`);
      } catch (e) {
        console.error("[SwapStatus] FA enrichment failed (using time-based guess):", e instanceof Error ? e.message : e);
      }
    }

    // Helper: convert ICAO code to IATA-ish (strip K prefix for US)
    const icaoToIata = (icao: string | undefined | null): string => {
      if (!icao) return "?";
      // US airports: KJFK → JFK, KLAX → LAX
      if (icao.length === 4 && icao.startsWith("K")) return icao.slice(1);
      // Canadian: CYYZ → YYZ
      if (icao.length === 4 && icao.startsWith("C")) return icao.slice(1);
      return icao;
    };

    // Helper: describe a single leg's delay concisely
    const legDelayLabel = (fa: CommercialFlightStatus): string => {
      const delay = fa.arrival_delay_minutes ?? fa.departure_delay_minutes ?? 0;
      if (fa.cancelled) return "cancelled";
      if (delay > 10) return `+${delay}m late`;
      if (fa.status === "Landed" || fa.status === "Arrived") return "landed";
      if (fa.status === "En Route" || fa.status === "Departed") return "en route";
      return "on time";
    };

    // Apply FA status to crew entries
    for (const crew of allCrew) {
      if (crew.transport_type !== "commercial" || crew.flight_numbers.length === 0) continue;

      // ── Build leg_details ──
      const legs: LegDetail[] = [];
      for (const fn of crew.flight_numbers) {
        const fa = faStatusMap.get(fn);
        if (fa) {
          legs.push({
            flight_number: fn,
            status: fa.cancelled ? "Cancelled" : (fa.status ?? "Scheduled"),
            delay_minutes: fa.arrival_delay_minutes ?? fa.departure_delay_minutes ?? null,
            origin: icaoToIata(fa.origin_icao),
            destination: icaoToIata(fa.destination_icao),
            scheduled_departure: fa.estimated_departure ?? null,
            actual_departure: fa.actual_departure ?? null,
            estimated_arrival: fa.estimated_arrival ?? null,
            actual_arrival: fa.actual_arrival ?? null,
          });
        } else {
          // No FA data yet — placeholder
          legs.push({
            flight_number: fn,
            status: "Scheduled",
            delay_minutes: null,
            origin: "",
            destination: "",
            scheduled_departure: null,
            actual_departure: null,
            estimated_arrival: null,
            actual_arrival: null,
          });
        }
      }
      crew.leg_details = legs;

      // ── Connection risk detection ──
      // If leg N's ETA is less than 45min before leg N+1's scheduled departure
      const CONNECTION_MIN_BUFFER = 45; // minutes
      crew.connection_at_risk = false;
      let connectionGapMinutes: number | null = null;
      if (legs.length >= 2) {
        for (let i = 0; i < legs.length - 1; i++) {
          const thisLeg = legs[i];
          const nextLeg = legs[i + 1];
          const thisArrival = thisLeg.actual_arrival ?? thisLeg.estimated_arrival;
          const nextDeparture = nextLeg.actual_departure ?? nextLeg.scheduled_departure;
          if (thisArrival && nextDeparture) {
            const gap = (new Date(nextDeparture).getTime() - new Date(thisArrival).getTime()) / 60000;
            if (gap < CONNECTION_MIN_BUFFER) {
              crew.connection_at_risk = true;
              connectionGapMinutes = Math.round(gap);
            }
          }
        }
      }

      // ── Overall status from legs (same logic as before, but enriched) ──
      let totalDelay = 0;
      let anyLanded = false;
      let allLanded = true;
      let anyCancelled = false;
      let lastLegStatus: CommercialFlightStatus | null = null;

      for (const fn of crew.flight_numbers) {
        const fa = faStatusMap.get(fn);
        if (!fa) { allLanded = false; continue; }

        if (fa.cancelled) anyCancelled = true;
        if (fa.status === "Landed" || fa.status === "Arrived") anyLanded = true;
        else allLanded = false;
        if (fa.arrival_delay_minutes) totalDelay += fa.arrival_delay_minutes;
        lastLegStatus = fa;
      }

      if (anyCancelled) {
        crew.status = "cancelled";
        crew.status_detail = "Flight cancelled";
      } else if (lastLegStatus) {
        // Map FA status to our status
        switch (lastLegStatus.status) {
          case "Scheduled": crew.status = "scheduled"; break;
          case "Departed": crew.status = "departed"; break;
          case "En Route": crew.status = "en_route"; break;
          case "Landed":
          case "Arrived":
            crew.status = "landed"; break;
          case "Diverted":
            crew.status = "delayed";
            crew.status_detail = "Flight diverted";
            break;
          default: crew.status = "scheduled";
        }

        // If first leg landed but second hasn't departed yet → first leg done
        if (crew.flight_numbers.length > 1 && !allLanded && anyLanded) {
          const firstFa = faStatusMap.get(crew.flight_numbers[0]);
          if (firstFa?.status === "Landed" || firstFa?.status === "Arrived") {
            crew.status = "en_route"; // in transit between connections
          }
        }

        if (totalDelay > 15) {
          crew.delay_minutes = totalDelay;
          if ((crew.status as string) !== "cancelled") {
            if (crew.status === "scheduled") crew.status = "delayed";
          }
        }

        // Set live times from FA
        crew.live_departure = lastLegStatus.actual_departure ?? lastLegStatus.estimated_departure ?? null;
        crew.live_arrival = lastLegStatus.actual_arrival ?? lastLegStatus.estimated_arrival ?? null;
      }

      // ── Build descriptive status_detail from per-leg info ──
      if ((crew.status as string) !== "cancelled") {
        const faLegs = crew.flight_numbers.map(fn => faStatusMap.get(fn)).filter(Boolean) as CommercialFlightStatus[];
        if (faLegs.length > 0) {
          if (crew.flight_numbers.length === 1) {
            // Single leg: "AA820 +42min late" or "AA820 on time"
            const fa = faLegs[0];
            const delay = fa.arrival_delay_minutes ?? fa.departure_delay_minutes ?? 0;
            if (fa.cancelled) {
              crew.status_detail = `${crew.flight_numbers[0]} cancelled`;
            } else if (delay > 10) {
              crew.status_detail = `${crew.flight_numbers[0]} +${delay}min late`;
            } else if (fa.status === "Landed" || fa.status === "Arrived") {
              crew.status_detail = `${crew.flight_numbers[0]} landed`;
            } else if (fa.status === "En Route" || fa.status === "Departed") {
              crew.status_detail = `${crew.flight_numbers[0]} en route`;
            } else {
              crew.status_detail = `${crew.flight_numbers[0]} on time`;
            }
          } else {
            // Multi-leg: "AA820 +42min late, AA1033 on time — connection tight (38min)"
            const parts = crew.flight_numbers.map(fn => {
              const fa = faStatusMap.get(fn);
              if (!fa) return `${fn} pending`;
              return `${fn} ${legDelayLabel(fa)}`;
            });
            let detail = parts.join(", ");
            if (crew.connection_at_risk && connectionGapMinutes != null) {
              detail += ` — connection tight (${connectionGapMinutes}min)`;
            }
            crew.status_detail = detail;
          }
        }
      }
    }

    // Cache live-enriched results
    if (!tabOverride) {
      liveCache = {
        data: {
          oncoming: oncoming.map(c => ({ ...c })),
          offgoing: offgoing.map(c => ({ ...c })),
          faResolved: faStatusMap.size,
        },
        timestamp: Date.now(),
      };
    }

    return NextResponse.json({
      swap_date: swapDate,
      sheet_name: targetSheet,
      oncoming,
      offgoing,
      fa_flights_resolved: faStatusMap.size,
      fa_flights_total: commercialFlightLegs.size,
      last_updated: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[SwapStatus] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load swap status" },
      { status: 500 },
    );
  }
}
