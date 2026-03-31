import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/ops/edct-lookup
 *
 * Batch-checks all flights for active EDCTs from FAA's fly.faa.gov/edct/ tool.
 * Fires all lookups in parallel, stores any results found in ops_alerts.
 *
 * Body: { flights: [{ callsign, tail, dept, arr }] }
 */

interface FlightInput {
  callsign: string;
  tail: string;
  dept: string;
  arr: string;
}

interface FaaEdctResult {
  callsign: string;
  tail: string;
  origin: string;
  destination: string;
  found: boolean;
  edct_time: string | null;           // ISO string
  filed_departure: string | null;     // ISO string
  control_element: string | null;
  cancelled: boolean;
  delay_minutes: number | null;
  raw_text: string;
  query: { callsign: string; dept: string; arr: string };
}

/** FAA expects 3-letter codes (no K prefix) for US airports */
function stripK(code: string): string {
  const u = code.toUpperCase();
  if (u.length === 4 && u.startsWith("K")) return u.slice(1);
  return u;
}

// Territories where ICAO differs from FAA K-prefix (ForeFlight uses ICAO, JetInsight uses FAA)
const TERRITORY_FAA_TO_ICAO: Record<string, string> = {
  KSJU: "TJSJ", KBQN: "TJBQ", KPSE: "TJPS", KSIG: "TJIG", // Puerto Rico
  KSTT: "TIST", KSTX: "TISX", // USVI
};
const TERRITORY_ICAO_TO_FAA: Record<string, string> = Object.fromEntries(
  Object.entries(TERRITORY_FAA_TO_ICAO).map(([k, v]) => [v, k]),
);

/** Get the code for FAA query — territories need ICAO, not stripped K-prefix */
function toFaaCode(icao: string): string {
  const territory = TERRITORY_FAA_TO_ICAO[icao.toUpperCase()];
  if (territory) return territory;
  return stripK(icao);
}

/** Parse FAA datetime "03/21/2026 16:40" → ISO string */
function parseFaaDateTime(s: string): string | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, dd, yyyy, hh, mm] = m;
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:00Z`;
}

async function lookupSingleEdct(flight: FlightInput): Promise<FaaEdctResult> {
  const dept = toFaaCode(flight.dept);
  const arr = toFaaCode(flight.arr);

  const result: FaaEdctResult = {
    callsign: flight.callsign,
    tail: flight.tail,
    origin: flight.dept,
    destination: flight.arr,
    found: false,
    edct_time: null,
    filed_departure: null,
    control_element: null,
    cancelled: false,
    delay_minutes: null,
    raw_text: "",
    query: { callsign: flight.callsign, dept, arr },
  };

  try {
    const res = await fetch("https://www.fly.faa.gov/edct/showEDCT", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `callsign=${encodeURIComponent(flight.callsign)}&dept=${encodeURIComponent(dept)}&arr=${encodeURIComponent(arr)}`,
    });

    if (!res.ok) {
      result.raw_text = `HTTP ${res.status}`;
      return result;
    }

    const html = await res.text();
    const text = html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    result.raw_text = text.slice(0, 2000);

    if (text.includes("No EDCT information is available")) {
      return result;
    }

    // Check for "found X record(s)"
    if (!text.includes("record(s) matching")) {
      // Unexpected response — log for debugging
      console.warn(`[edct-lookup] ${flight.callsign} ${dept}→${arr}: unexpected response (no 'record(s)' and no 'No EDCT'): ${text.slice(0, 300)}`);
      return result;
    }

    result.found = true;

    // FAA table format: EDCT | Filed Departure Time | Control Element | Flight Cancelled?
    // Values like: 03/21/2026 16:40 | 03/21/2026 16:00 | FCAJXW | No
    const datetimePattern = /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/g;
    const dateTimes = [...text.matchAll(datetimePattern)].map((m) => m[1]);

    if (dateTimes.length >= 2) {
      result.edct_time = parseFaaDateTime(dateTimes[0]);
      result.filed_departure = parseFaaDateTime(dateTimes[1]);

      // Calculate delay
      if (result.edct_time && result.filed_departure) {
        const edctMs = new Date(result.edct_time).getTime();
        const filedMs = new Date(result.filed_departure).getTime();
        result.delay_minutes = Math.round((edctMs - filedMs) / 60000);
      }
    } else if (dateTimes.length === 1) {
      result.edct_time = parseFaaDateTime(dateTimes[0]);
    }

    // Extract control element (e.g. FCAJXW)
    const ctrlMatch = text.match(/(?:Control Element|FCAJXW|FCA\w+|GDP\w*|GS\w*|AFP\w*)\s*/i);
    // More robust: look for the text between the second datetime and "No"/"Yes"
    const afterTimes = text.split(dateTimes[dateTimes.length - 1] ?? "").pop() ?? "";
    const ctrlParts = afterTimes.trim().split(/\s+/);
    if (ctrlParts.length >= 1 && ctrlParts[0] && !["No", "Yes", "Notes:", "EDCT"].includes(ctrlParts[0])) {
      result.control_element = ctrlParts[0];
    }

    // Check cancelled
    result.cancelled = text.includes("Yes") && text.indexOf("Yes") > text.indexOf(dateTimes[dateTimes.length - 1] ?? "");

    console.log(`[edct-lookup] ${flight.callsign} ${dept}→${arr}: FOUND edct=${result.edct_time} filed=${result.filed_departure}`);
    return result;
  } catch (err) {
    console.error(`[edct-lookup] ${flight.callsign} ${dept}→${arr}: ERROR`, err);
    return result;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const flights: FlightInput[] = body?.flights;

  if (!flights?.length) {
    return NextResponse.json({ error: "flights array is required" }, { status: 400 });
  }

  // Get tail → callsign mapping from ics_sources
  const supa = createServiceClient();
  const { data: icsSources } = await supa
    .from("ics_sources")
    .select("label, callsign")
    .not("callsign", "is", null);

  const callsignMap = new Map<string, string>();
  for (const s of icsSources ?? []) {
    if (s.label && s.callsign) {
      callsignMap.set(s.label.toUpperCase(), s.callsign.toUpperCase());
    }
  }

  // Override callsigns with the real mapping + add N-number lookups
  // For territory airports (PR/USVI), also try ICAO variant
  const expanded: FlightInput[] = [];
  const seenKeys = new Set<string>();

  function addExpanded(cs: string, tail: string, dept: string, arr: string) {
    const key = `${cs}|${dept}|${arr}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    expanded.push({ callsign: cs, tail, dept, arr });
  }

  for (const f of flights) {
    const tail = f.tail.toUpperCase();
    const mapped = callsignMap.get(tail);
    const dept = f.dept;
    const arr = f.arr;

    // Build alternate codes for territories (KSJU↔TJSJ)
    const deptAlt = TERRITORY_FAA_TO_ICAO[dept] ?? TERRITORY_ICAO_TO_FAA[dept] ?? null;
    const arrAlt = TERRITORY_FAA_TO_ICAO[arr] ?? TERRITORY_ICAO_TO_FAA[arr] ?? null;
    const deptCodes = deptAlt ? [dept, deptAlt] : [dept];
    const arrCodes = arrAlt ? [arr, arrAlt] : [arr];

    for (const d of deptCodes) {
      for (const a of arrCodes) {
        if (mapped) addExpanded(mapped, tail, d, a);
        addExpanded(tail, tail, d, a);
      }
    }
  }

  // Fire lookups in batches of 10 to avoid FAA rate limiting
  const results: FaaEdctResult[] = [];
  const batchSize = 10;
  for (let i = 0; i < expanded.length; i += batchSize) {
    const batch = expanded.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(lookupSingleEdct));
    results.push(...batchResults);
  }

  const found = results.filter((r) => r.found);

  // Store any found EDCTs as ops_alerts (upsert by source_message_id to avoid duplicates)
  // Skip EDCTs from before today (UTC) and cancelled ones — keep until end of day
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();

  if (found.length > 0) {
    for (const edct of found) {
      if (edct.edct_time && new Date(edct.edct_time).getTime() < todayStart) continue;

      const sourceId = `faa-edct-${edct.callsign}-${edct.origin}-${edct.destination}`;
      const delayStr = edct.delay_minutes != null ? `${edct.delay_minutes}min delay` : "";
      const ctrlStr = edct.control_element ? ` — ${edct.control_element}` : "";

      await supa.from("ops_alerts").upsert({
        source_message_id: sourceId,
        alert_type: "EDCT",
        severity: "warning",
        tail_number: edct.tail,
        departure_icao: edct.origin,
        arrival_icao: edct.destination,
        subject: `FAA EDCT: ${edct.callsign} ${edct.origin}→${edct.destination}`,
        body: `EDCT ${edct.edct_time ? new Date(edct.edct_time).toISOString().slice(11, 16) + "Z" : "?"} (${delayStr}${ctrlStr})`,
        edct_time: edct.edct_time,
        original_departure_time: edct.filed_departure,
        raw_data: { faa_edct: edct },
      }, { onConflict: "source_message_id" });
    }
  }

  // Count current (non-stale) as "found" for the UI — include cancelled
  const current = found.filter((r) =>
    !r.edct_time || new Date(r.edct_time).getTime() >= todayStart
  );

  return NextResponse.json({
    ok: true,
    checked: expanded.length,
    found: current.length,
    stale: found.length - current.length,
    results,
  });
}

// Keep GET for single lookups
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const callsign = searchParams.get("callsign");
  const dept = searchParams.get("dept");
  const arr = searchParams.get("arr");

  if (!callsign || !dept || !arr) {
    return NextResponse.json({ error: "callsign, dept, and arr are required" }, { status: 400 });
  }

  const result = await lookupSingleEdct({ callsign, tail: "", dept, arr });

  return NextResponse.json({
    ok: true,
    found: result.found,
    callsign,
    origin: dept,
    destination: arr,
    ...(result.found ? { edct: result } : { message: "No active EDCT found" }),
  });
}
