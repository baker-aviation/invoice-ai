import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EDCT_SLACK_CHANNEL = "C0A5ETR7YS2";
const BATCH_SIZE = 15;

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

/** FAA expects 3-letter codes */
function stripK(code: string): string {
  const u = code.toUpperCase();
  if (u.length === 4 && u.startsWith("K")) return u.slice(1);
  return u;
}

/** Parse FAA datetime "03/21/2026 16:40" → ISO string */
function parseFaaDateTime(s: string): string | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, dd, yyyy, hh, mm] = m;
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:00Z`;
}

async function lookupEdct(flight: FlightInput): Promise<FaaEdctResult> {
  const dept = stripK(flight.dept);
  const arr = stripK(flight.arr);
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

    // Control element
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

function fmtZulu(iso: string | null): string {
  if (!iso) return "?";
  return iso.slice(11, 16) + "Z";
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();

  // 1. Get today's undeparted flights
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const tomorrowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const oneHourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();

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

  // 3. Build deduplicated flight list
  const seen = new Set<string>();
  const flights: FlightInput[] = [];
  for (const f of flightRows) {
    if (!f.tail_number || !f.departure_icao || !f.arrival_icao) continue;
    const tail = f.tail_number.toUpperCase();
    const callsign = callsignMap.get(tail);
    if (!callsign) continue; // Skip tails without callsign
    const key = `${callsign}|${f.departure_icao}|${f.arrival_icao}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flights.push({ callsign, tail, dept: f.departure_icao, arr: f.arrival_icao });
  }

  // 4. Check FAA in batches of 15
  const results: FaaEdctResult[] = [];
  for (let i = 0; i < flights.length; i += BATCH_SIZE) {
    const batch = flights.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(lookupEdct));
    results.push(...batchResults);
  }

  // 5. Filter to current, non-cancelled EDCTs
  const todayStartMs = new Date(todayStart).getTime();
  const found = results.filter((r) =>
    r.found && !r.cancelled && (!r.edct_time || new Date(r.edct_time).getTime() >= todayStartMs)
  );

  // 6. Get existing FAA EDCT source IDs to detect NEW ones
  const { data: existingAlerts } = await supa
    .from("ops_alerts")
    .select("source_message_id")
    .like("source_message_id", "faa-edct-%")
    .gte("created_at", todayStart);

  const existingIds = new Set((existingAlerts ?? []).map((a) => a.source_message_id));

  // 7. Store found EDCTs + track new ones for Slack
  const newEdcts: FaaEdctResult[] = [];

  for (const edct of found) {
    const sourceId = `faa-edct-${edct.callsign}-${edct.origin}-${edct.destination}`;
    const isNew = !existingIds.has(sourceId);

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
      body: `EDCT ${fmtZulu(edct.edct_time)} (${delayStr}${ctrlStr})`,
      edct_time: edct.edct_time,
      original_departure_time: edct.filed_departure,
      raw_data: { faa_edct: edct },
    }, { onConflict: "source_message_id" });

    if (isNew) newEdcts.push(edct);
  }

  // 8. Slack notification for newly discovered EDCTs
  if (newEdcts.length > 0) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (token) {
      const lines = newEdcts.map((e) => {
        const delay = e.delay_minutes != null ? ` (+${e.delay_minutes}min)` : "";
        const ctrl = e.control_element ? ` [${e.control_element}]` : "";
        return `*${e.tail}* (${e.callsign})  ${stripK(e.origin)}→${stripK(e.destination)}  Filed: ${fmtZulu(e.filed_departure)} → EDCT: *${fmtZulu(e.edct_time)}*${delay}${ctrl}`;
      });

      const blocks = [
        {
          type: "header",
          text: { type: "plain_text", text: `New FAA EDCT${newEdcts.length > 1 ? "s" : ""} Detected`, emoji: true },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: lines.join("\n") },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Source: FAA ATCSCC  •  ${new Date().toISOString().slice(11, 16)}Z` }],
        },
      ];

      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: EDCT_SLACK_CHANNEL,
          text: `New FAA EDCT${newEdcts.length > 1 ? "s" : ""}: ${newEdcts.map((e) => `${e.tail} ${stripK(e.origin)}→${stripK(e.destination)} EDCT ${fmtZulu(e.edct_time)}`).join(", ")}`,
          blocks,
        }),
      });
    }
  }

  console.log(`[edct-tracker] Checked ${flights.length} flights, found ${found.length} EDCTs, ${newEdcts.length} new → Slack`);

  return NextResponse.json({
    ok: true,
    checked: flights.length,
    found: found.length,
    new: newEdcts.length,
    edcts: found.map((e) => ({
      callsign: e.callsign, tail: e.tail,
      route: `${e.origin}→${e.destination}`,
      edct: fmtZulu(e.edct_time),
      filed: fmtZulu(e.filed_departure),
      delay: e.delay_minutes,
    })),
  });
}
