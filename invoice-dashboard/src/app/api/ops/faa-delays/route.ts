import { NextResponse } from "next/server";

/**
 * Fetches FAA NAS Status airport delays/ground stops/closures.
 * Parses the XML feed and returns structured JSON.
 * No auth required — public FAA API.
 */

export type FaaDelay = {
  airport: string;
  type: "ground_stop" | "ground_delay" | "arrival_departure" | "closure";
  reason: string;
  /** Human-readable detail line */
  detail: string;
};

export type FaaAfp = {
  name: string;
  reason: string;
  avg: string;
  floor: string;
  ceiling: string;
  afpStart: string;
  afpEnd: string;
  fcaStart: string;
  fcaEnd: string;
  /** Line geometry: array of [lat, lon] */
  line: [number, number][] | null;
  /** Circle geometry */
  circle: { lat: number; lon: number; radiusNm: number } | null;
};

export type FaaDelaysResponse = {
  ok: boolean;
  updated: string;
  delays: FaaDelay[];
  afps: FaaAfp[];
};

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function extractAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "g");
  return xml.match(re) ?? [];
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function cleanReason(raw: string): string {
  // Strip NOTAM-style prefixes like "!TISX 02/050 STX AD AP CLSD..."
  const r = raw.replace(/^![A-Z]{4}\s+\d+\/\d+\s+[A-Z]{3}\s+AD\s+AP\s+/i, "");
  return r.length > 120 ? r.slice(0, 117) + "…" : r;
}

export async function GET() {
  try {
    const res = await fetch(
      "https://nasstatus.faa.gov/api/airport-status-information",
      { cache: "no-store", headers: { Accept: "application/xml" } },
    );

    if (!res.ok) {
      console.error(`[faa-delays] FAA API returned HTTP ${res.status}`);
      return NextResponse.json(
        { ok: false, updated: "", delays: [], afps: [] } satisfies FaaDelaysResponse,
        { status: 502 },
      );
    }

    const xml = await res.text();
    const updated = extractTag(xml, "Update_Time");
    const delays: FaaDelay[] = [];

    // Parse Delay_type blocks
    const delayTypes = extractAllBlocks(xml, "Delay_type");

    for (const block of delayTypes) {
      const name = extractTag(block, "Name");

      if (name === "Ground Stop Programs") {
        for (const prog of extractAllBlocks(block, "Program")) {
          const airport = extractTag(prog, "ARPT");
          const reason = extractTag(prog, "Reason");
          const endTime = extractTag(prog, "End_Time");
          if (airport) {
            delays.push({
              airport,
              type: "ground_stop",
              reason,
              detail: `Ground Stop until ${endTime || "TBD"}`,
            });
          }
        }
      } else if (name === "Ground Delay Programs") {
        for (const gdp of extractAllBlocks(block, "Ground_Delay")) {
          const airport = extractTag(gdp, "ARPT");
          const reason = extractTag(gdp, "Reason");
          const avg = extractTag(gdp, "Avg");
          const max = extractTag(gdp, "Max");
          if (airport) {
            delays.push({
              airport,
              type: "ground_delay",
              reason,
              detail: `GDP: avg ${avg}, max ${max}`,
            });
          }
        }
      } else if (name.includes("Arrival/Departure")) {
        for (const d of extractAllBlocks(block, "Delay")) {
          const airport = extractTag(d, "ARPT");
          const reason = extractTag(d, "Reason");
          const adType = extractAttr(d, "Arrival_Departure", "Type");
          const min = extractTag(d, "Min");
          const max = extractTag(d, "Max");
          const trend = extractTag(d, "Trend");
          if (airport) {
            delays.push({
              airport,
              type: "arrival_departure",
              reason,
              detail: `${adType || "Delay"}: ${min}–${max}${trend ? ` (${trend})` : ""}`,
            });
          }
        }
      } else if (name.includes("Closure")) {
        for (const c of extractAllBlocks(block, "Airport")) {
          const airport = extractTag(c, "ARPT");
          const reason = extractTag(c, "Reason");
          const reopen = extractTag(c, "Reopen");
          if (airport) {
            delays.push({
              airport,
              type: "closure",
              reason: cleanReason(reason),
              detail: `CLOSED${reopen ? ` — reopens ${reopen}` : ""}`,
            });
          }
        }
      }
    }

    // Parse Airspace Flow Programs (AFPs with FCA geometry)
    const afps: FaaAfp[] = [];
    for (const af of extractAllBlocks(xml, "Airspace_Flow")) {
      const name = extractTag(af, "CTL_Element");
      if (!name) continue;

      const reason = extractTag(af, "Reason");
      const avg = extractTag(af, "Avg");
      const floor = extractTag(af, "Floor");
      const ceiling = extractTag(af, "Ceiling");
      const afpStart = extractTag(af, "AFP_StartTime");
      const afpEnd = extractTag(af, "AFP_EndTime");
      const fcaStart = extractTag(af, "FCA_StartDateTime");
      const fcaEnd = extractTag(af, "FCA_EndDateTime");

      // Parse Line geometry
      let line: [number, number][] | null = null;
      const lineBlock = af.match(/<Line>[\s\S]*?<\/Line>/);
      if (lineBlock) {
        const points: [number, number][] = [];
        const pointRe = /Point\s+Lat="([^"]+)"\s+Long="([^"]+)"/g;
        let pm;
        while ((pm = pointRe.exec(lineBlock[0])) !== null) {
          points.push([parseFloat(pm[1]), parseFloat(pm[2])]);
        }
        if (points.length >= 2) line = points;
      }

      // Parse Circle geometry
      let circle: FaaAfp["circle"] = null;
      const circleBlock = af.match(/<Circle[\s\S]*?<\/Circle>/);
      if (circleBlock) {
        const radiusMatch = circleBlock[0].match(/Radius="([^"]+)"/);
        const centerMatch = circleBlock[0].match(/Center\s+Lat="([^"]+)"\s+Long="([^"]+)"/);
        if (radiusMatch && centerMatch) {
          circle = {
            lat: parseFloat(centerMatch[1]),
            lon: parseFloat(centerMatch[2]),
            radiusNm: parseFloat(radiusMatch[1]),
          };
        }
      }

      afps.push({ name, reason, avg, floor, ceiling, afpStart, afpEnd, fcaStart, fcaEnd, line, circle });
    }

    return NextResponse.json(
      { ok: true, updated, delays, afps } satisfies FaaDelaysResponse,
      {
        headers: {
          "Cache-Control": "public, max-age=120, stale-while-revalidate=180",
        },
      },
    );
  } catch (err) {
    console.error("[faa-delays] Failed to fetch FAA status:", err);
    return NextResponse.json(
      { ok: false, updated: "", delays: [], afps: [] } satisfies FaaDelaysResponse,
      { status: 502 },
    );
  }
}
