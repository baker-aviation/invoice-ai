import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportTimezone } from "@/lib/airportTimezones";
import { postSlackMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EDCT_SLACK_CHANNEL = "C0A5ETR7YS2";
const BATCH_SIZE = 15;

// ─── Types ─────────────────────────────────────────────────────────────

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
  edct_time: string | null;
  filed_departure: string | null;
  control_element: string | null;
  cancelled: boolean;
  delay_minutes: number | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

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

/** Get the ICAO code for FAA query — territories need ICAO, not stripped K-prefix */
function toFaaCode(icao: string): string {
  // If it's a territory stored as K-prefix (KSJU), use the real ICAO (TJSJ)
  const territory = TERRITORY_FAA_TO_ICAO[icao.toUpperCase()];
  if (territory) return territory;
  // Normal US domestic — strip K
  return stripK(icao);
}

function parseFaaDateTime(s: string): string | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, dd, yyyy, hh, mm] = m;
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:00Z`;
}

/** Format ISO time in airport local timezone: "09:33 EDT" */
function fmtLocal(iso: string | null, airportIcao: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "?";
  const tz = getAirportTimezone(airportIcao);
  if (!tz) return iso.slice(11, 16) + "Z";
  try {
    const time = d.toLocaleString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
    });
    const tzAbbr = d.toLocaleString("en-US", { timeZoneName: "short", timeZone: tz })
      .split(" ").pop() ?? "";
    return `${time} ${tzAbbr}`;
  } catch {
    return iso.slice(11, 16) + "Z";
  }
}

// ─── FAA Lookup ────────────────────────────────────────────────────────

async function lookupEdct(flight: FlightInput): Promise<FaaEdctResult> {
  const dept = toFaaCode(flight.dept);
  const arr = toFaaCode(flight.arr);
  const result: FaaEdctResult = {
    callsign: flight.callsign, tail: flight.tail,
    origin: flight.dept, destination: flight.arr,
    found: false, edct_time: null, filed_departure: null,
    control_element: null, cancelled: false, delay_minutes: null,
  };

  try {
    const res = await fetch("https://www.fly.faa.gov/edct/showEDCT", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `callsign=${encodeURIComponent(flight.callsign)}&dept=${encodeURIComponent(dept)}&arr=${encodeURIComponent(arr)}`,
    });
    if (!res.ok) return result;

    const html = await res.text();
    const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

    if (text.includes("No EDCT information is available") || !text.includes("record(s) matching")) {
      return result;
    }

    result.found = true;

    const datetimePattern = /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/g;
    const dateTimes = [...text.matchAll(datetimePattern)].map((m) => m[1]);

    if (dateTimes.length >= 2) {
      result.edct_time = parseFaaDateTime(dateTimes[0]);
      result.filed_departure = parseFaaDateTime(dateTimes[1]);
      if (result.edct_time && result.filed_departure) {
        result.delay_minutes = Math.round(
          (new Date(result.edct_time).getTime() - new Date(result.filed_departure).getTime()) / 60000
        );
      }
    } else if (dateTimes.length === 1) {
      result.edct_time = parseFaaDateTime(dateTimes[0]);
    }

    const afterTimes = text.split(dateTimes[dateTimes.length - 1] ?? "").pop() ?? "";
    const parts = afterTimes.trim().split(/\s+/);
    if (parts[0] && !["No", "Yes", "Notes:", "EDCT"].includes(parts[0])) {
      result.control_element = parts[0];
    }

    result.cancelled = text.includes("Yes") && text.indexOf("Yes") > text.indexOf(dateTimes[dateTimes.length - 1] ?? "");
    return result;
  } catch {
    return result;
  }
}

// ─── Slack ─────────────────────────────────────────────────────────────

function buildEdctSlackBlocks(
  edct: FaaEdctResult,
  salesperson: string | null,
  type: "new" | "updated",
  previousEdctTime?: string | null,
): Record<string, unknown>[] {
  const depIcao = edct.origin;
  const dept = stripK(edct.origin);
  const arr = stripK(edct.destination);
  const edctLocal = fmtLocal(edct.edct_time, depIcao);
  const filedLocal = fmtLocal(edct.filed_departure, depIcao);
  const delay = edct.delay_minutes != null ? `+${edct.delay_minutes}min` : "";
  const ctrl = edct.control_element ?? "";

  const blocks: Record<string, unknown>[] = [];

  if (type === "new") {
    // New EDCT message
    const isCallsign = edct.callsign !== edct.tail;
    const tailPart = isCallsign ? `*${edct.tail}* (${edct.callsign}✱)` : `*${edct.tail}*✱ (${edct.callsign})`;
    let text = `${tailPart}  ${dept} → ${arr}`;
    if (edct.cancelled) text += `  ~cancelled~`;
    text += `\nFiled: ${filedLocal}  →  EDCT: *${edctLocal}*  (${delay})`;
    if (ctrl) text += `\nControl: ${ctrl}`;
    if (salesperson) text += `\nSales: ${salesperson}`;
    if (edct.cancelled) text += `\n:no_entry: Flight plan cancelled — pilot may have refiled for better slot`;

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `New FAA EDCT  •  ${new Date().toISOString().slice(11, 16)}Z` }],
    });
  } else {
    // Updated EDCT message
    const prevLocal = fmtLocal(previousEdctTime ?? null, depIcao);
    const isCallsign = edct.callsign !== edct.tail;
    const tailPart = isCallsign ? `*${edct.tail}* (${edct.callsign}✱)` : `*${edct.tail}*✱ (${edct.callsign})`;
    let text = `${tailPart}  ${dept} → ${arr}`;
    text += `\nEDCT Updated: ${prevLocal} → *${edctLocal}*`;
    if (edct.edct_time && previousEdctTime) {
      const diffMin = Math.round((new Date(edct.edct_time).getTime() - new Date(previousEdctTime).getTime()) / 60000);
      const direction = diffMin > 0 ? `${diffMin}min later` : `${Math.abs(diffMin)}min earlier`;
      text += `  (${direction})`;
    }
    text += `\nFiled: ${filedLocal}  •  Delay: ${delay}`;
    if (ctrl) text += `  •  Control: ${ctrl}`;
    if (salesperson) text += `\nSales: ${salesperson}`;

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `EDCT Changed  •  ${new Date().toISOString().slice(11, 16)}Z` }],
    });
  }

  return blocks;
}

// ─── Main Handler ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const tomorrowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const oneHourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();

  // 1. Get today's undeparted flights
  const { data: flightRows } = await supa
    .from("flights")
    .select("tail_number, departure_icao, arrival_icao, scheduled_departure")
    .gte("scheduled_departure", oneHourAgo)
    .lte("scheduled_departure", tomorrowStart)
    .order("scheduled_departure", { ascending: true });

  if (!flightRows?.length) {
    return NextResponse.json({ ok: true, message: "No flights to check", checked: 0, found: 0 });
  }

  // 2. Get callsign map
  const { data: icsSources } = await supa
    .from("ics_sources")
    .select("label, callsign")
    .not("callsign", "is", null);

  const callsignMap = new Map<string, string>();
  for (const s of icsSources ?? []) {
    if (s.label && s.callsign) callsignMap.set(s.label.toUpperCase(), s.callsign.toUpperCase());
  }

  // 3. Get salesperson map: "TAIL|DEPT_ICAO" → salesperson name
  const { data: tripRows } = await supa
    .from("trip_salespersons")
    .select("tail_number, origin_icao, salesperson_name, scheduled_departure")
    .gte("scheduled_departure", todayStart)
    .lte("scheduled_departure", tomorrowStart);

  const salespersonMap = new Map<string, string>();
  for (const t of tripRows ?? []) {
    if (t.tail_number && t.origin_icao && t.salesperson_name) {
      salespersonMap.set(`${t.tail_number.toUpperCase()}|${t.origin_icao}`, t.salesperson_name);
    }
  }

  // 4. Build deduplicated flight list — check both KOW callsign AND N-number
  // Pilots sometimes file under N-number to shop for better EDCT slots
  // For territory airports (PR/USVI), also try the ICAO variant since pilots
  // may file under TJSJ while JetInsight stores KSJU
  const seen = new Set<string>();
  const flights: FlightInput[] = [];

  function addFlight(cs: string, tail: string, dept: string, arr: string) {
    const key = `${cs}|${dept}|${arr}`;
    if (seen.has(key)) return;
    seen.add(key);
    flights.push({ callsign: cs, tail, dept, arr });
  }

  for (const f of flightRows) {
    if (!f.tail_number || !f.departure_icao || !f.arrival_icao) continue;
    const tail = f.tail_number.toUpperCase();
    const callsign = callsignMap.get(tail);
    const dept = f.departure_icao as string;
    const arr = f.arrival_icao as string;

    // Build alternate codes for territories (KSJU↔TJSJ)
    const deptAlt = TERRITORY_FAA_TO_ICAO[dept] ?? TERRITORY_ICAO_TO_FAA[dept] ?? null;
    const arrAlt = TERRITORY_FAA_TO_ICAO[arr] ?? TERRITORY_ICAO_TO_FAA[arr] ?? null;
    const deptCodes = deptAlt ? [dept, deptAlt] : [dept];
    const arrCodes = arrAlt ? [arr, arrAlt] : [arr];

    for (const d of deptCodes) {
      for (const a of arrCodes) {
        if (callsign) addFlight(callsign, tail, d, a);
        addFlight(tail, tail, d, a);
      }
    }
  }

  // 5. Check FAA in batches
  const results: FaaEdctResult[] = [];
  for (let i = 0; i < flights.length; i += BATCH_SIZE) {
    const batch = flights.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(lookupEdct));
    results.push(...batchResults);
  }

  // 6. Filter to current — require edct_time unless cancelled (pilots shop for slots)
  // Deduplicate by tail+destination — territory variants (KSJU/TJSJ) and callsign/N-number
  // produce multiple hits for the same physical flight. Keep the KOW callsign version if available.
  const todayStartMs = new Date(todayStart).getTime();
  const currentResults = results.filter((r) =>
    r.found && (r.edct_time
      ? new Date(r.edct_time).getTime() >= todayStartMs
      : r.cancelled)
  );

  const dedupMap = new Map<string, FaaEdctResult>();
  for (const r of currentResults) {
    const arrNorm = stripK(r.destination);
    const key = `${r.tail}|${arrNorm}|${r.edct_time ?? "cancelled"}`;
    const existing = dedupMap.get(key);
    // Prefer KOW callsign over N-number (has salesperson lookup + cleaner display)
    if (!existing || (r.callsign !== r.tail && existing.callsign === existing.tail)) {
      dedupMap.set(key, r);
    }
  }
  const found = [...dedupMap.values()];

  // 7. Get existing FAA EDCT alerts to detect new vs updated
  // Look back 48h — an EDCT detected yesterday evening (before UTC midnight)
  // would have yesterday's created_at and get missed by a todayStart filter,
  // causing the same alert to re-post to Slack every cron cycle.
  const alertLookback = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
  const { data: existingAlerts } = await supa
    .from("ops_alerts")
    .select("source_message_id, edct_time, raw_data")
    .like("source_message_id", "faa-edct-%")
    .gte("created_at", alertLookback);

  const existingMap = new Map<string, { edct_time: string | null; history: string[] }>();
  for (const a of existingAlerts ?? []) {
    existingMap.set(a.source_message_id, {
      edct_time: a.edct_time,
      history: (a.raw_data as Record<string, unknown>)?.edct_history as string[] ?? [],
    });
  }

  // 8. Store EDCTs + track new/updated for Slack
  const newEdcts: FaaEdctResult[] = [];
  const updatedEdcts: { edct: FaaEdctResult; previousEdctTime: string | null }[] = [];

  for (const edct of found) {
    const sourceId = `faa-edct-${edct.callsign}-${edct.origin}-${edct.destination}`;
    const existing = existingMap.get(sourceId);
    const isNew = !existing || (existing && !existing.edct_time && !!edct.edct_time);
    const isUpdated = !isNew && existing && existing.edct_time && edct.edct_time && existing.edct_time !== edct.edct_time;

    // Build history
    const history = existing?.history ?? [];
    if (isUpdated && existing.edct_time) {
      history.push(existing.edct_time);
    }

    const delayStr = edct.delay_minutes != null ? `${edct.delay_minutes}min delay` : "";
    const ctrlStr = edct.control_element ? ` — ${edct.control_element}` : "";

    await supa.from("ops_alerts").upsert({
      source_message_id: sourceId,
      alert_type: "EDCT",
      severity: "warning",
      tail_number: edct.tail,
      departure_icao: edct.origin,
      arrival_icao: edct.destination,
      subject: `FAA EDCT: ${edct.callsign} ${edct.origin}→${edct.destination}${edct.cancelled ? " (cancelled)" : ""}`,
      body: `EDCT ${fmtLocal(edct.edct_time, edct.origin)} (${delayStr}${ctrlStr})${edct.cancelled ? " — flight plan cancelled" : ""}`,
      edct_time: edct.edct_time,
      original_departure_time: edct.filed_departure,
      raw_data: { faa_edct: edct, edct_history: history },
      // Clear ack when real EDCT replaces a ghost record
      ...(isNew && existing ? { acknowledged_at: null, acknowledged_by: null } : {}),
    }, { onConflict: "source_message_id" });

    if (isNew) newEdcts.push(edct);
    if (isUpdated) updatedEdcts.push({ edct, previousEdctTime: existing.edct_time });
  }

  // 9. Send Slack messages — one per EDCT (new or updated), respects kill switch
  if (newEdcts.length > 0 || updatedEdcts.length > 0) {
    for (const edct of newEdcts) {
      const sp = salespersonMap.get(`${edct.tail}|${edct.origin}`) ?? null;
      const blocks = buildEdctSlackBlocks(edct, sp, "new");
      const fallback = `New FAA EDCT: ${edct.tail} ${stripK(edct.origin)}→${stripK(edct.destination)} EDCT ${fmtLocal(edct.edct_time, edct.origin)}`;
      await postSlackMessage({ channel: EDCT_SLACK_CHANNEL, text: fallback, blocks });
    }

    for (const { edct, previousEdctTime } of updatedEdcts) {
      const sp = salespersonMap.get(`${edct.tail}|${edct.origin}`) ?? null;
      const blocks = buildEdctSlackBlocks(edct, sp, "updated", previousEdctTime);
      const fallback = `EDCT Updated: ${edct.tail} ${stripK(edct.origin)}→${stripK(edct.destination)} ${fmtLocal(previousEdctTime ?? null, edct.origin)} → ${fmtLocal(edct.edct_time, edct.origin)}`;
      await postSlackMessage({ channel: EDCT_SLACK_CHANNEL, text: fallback, blocks });
    }
  }

  console.log(`[edct-tracker] Checked ${flights.length}, found ${found.length}, new ${newEdcts.length}, updated ${updatedEdcts.length}`);

  return NextResponse.json({
    ok: true,
    checked: flights.length,
    found: found.length,
    new: newEdcts.length,
    updated: updatedEdcts.length,
  });
}
