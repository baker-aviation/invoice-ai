import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";
import { getAirportInfo } from "@/lib/airportCoords";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FBO_BOSSES_CHANNEL = "C09QDTN5GHF";

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();
  const now = new Date();
  const horizon = new Date(now.getTime() + 72 * 3600_000).toISOString();

  // Get all FBO_MISMATCH alerts
  const { data: alerts, error } = await supa
    .from("ops_alerts")
    .select("tail_number, airport_icao, body, flight_id")
    .eq("alert_type", "FBO_MISMATCH");

  if (error) {
    console.error("[fbo-mismatch-digest] query error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!alerts?.length) {
    console.log("[fbo-mismatch-digest] no mismatches — skipping");
    return NextResponse.json({ ok: true, sent: false, count: 0 });
  }

  // Filter to mismatches where the departing leg is within 72hr
  const flightIds = alerts.map((a) => a.flight_id).filter(Boolean) as string[];
  const { data: flights } = await supa
    .from("flights")
    .select("id, scheduled_departure")
    .in("id", flightIds)
    .lte("scheduled_departure", horizon);

  const inWindowIds = new Set((flights ?? []).map((f) => f.id));
  const relevant = alerts.filter((a) => a.flight_id && inWindowIds.has(a.flight_id));

  if (!relevant.length) {
    console.log("[fbo-mismatch-digest] no mismatches in 72hr window — skipping");
    return NextResponse.json({ ok: true, sent: false, count: 0 });
  }

  // Build message
  const today = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

  const lines: string[] = [
    `:twisted_rightwards_arrows: *FBO Mismatch Report — ${today}*`,
    `_${relevant.length} mismatch${relevant.length === 1 ? "" : "es"} in the next 72 hours_`,
    "",
  ];

  for (const a of relevant) {
    const info = getAirportInfo(a.airport_icao ?? "");
    const airportLabel = info ? `${a.airport_icao} (${info.city})` : a.airport_icao;

    // Parse FBO names from body: "Arriving at X but departing from Y at ICAO..."
    const m = a.body?.match(/Arriving at (.+?) but departing from (.+?) at /);
    const arrFbo = m?.[1] ?? "?";
    const depFbo = m?.[2] ?? "?";

    lines.push(`*${a.tail_number}* at *${airportLabel}*`);
    lines.push(`Arriving at *${arrFbo}* → Departing from *${depFbo}*`);
    lines.push("");
  }

  const message = lines.join("\n").trimEnd();

  const result = await postSlackMessage({
    channel: FBO_BOSSES_CHANNEL,
    text: message,
  });

  console.log(`[fbo-mismatch-digest] sent ${relevant.length} mismatches to #fbo-bosses`);
  return NextResponse.json({ ok: true, sent: true, count: relevant.length, slack: result });
}
