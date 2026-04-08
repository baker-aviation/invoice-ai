import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { parseFuelChoices } from "@/lib/jetinsight/trip-notes-sync";
import * as cheerio from "cheerio";

export const dynamic = "force-dynamic";

const BASE_URL = "https://portal.jetinsight.com";

/**
 * GET /api/debug/trip-notes?tripId=XXX
 *
 * Fetches a single trip's notes from JetInsight and returns:
 * - Raw body text (what the parser sees)
 * - Parsed fuel choices (what the regex matched)
 * - Any fuel-like lines that look like they SHOULD match but didn't
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tripId = req.nextUrl.searchParams.get("tripId");
  if (!tripId) {
    return NextResponse.json({ error: "tripId required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    return NextResponse.json({ error: "No session cookie" }, { status: 500 });
  }

  const url = `${BASE_URL}/trips/${tripId}/notes`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Fetch failed: ${res.status}` }, { status: 502 });
  }

  const html = await res.text();

  if (html.includes("sign_in") && (html.includes("Forgot your password") || html.includes("recaptcha"))) {
    return NextResponse.json({ error: "Session expired" }, { status: 401 });
  }

  const $ = cheerio.load(html);
  const bodyText = $("body").text();

  // Parse with current regex
  const parsed = parseFuelChoices(html, tripId);

  // Find lines that look fuel-related but didn't match
  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const fuelLines = lines.filter((l) => /fuel/i.test(l) && !(/fuel\s*surcharge|fuel\s*flowage|defuel/i.test(l)));

  return NextResponse.json({
    ok: true,
    tripId,
    parsed,
    parsedCount: parsed.length,
    fuelRelatedLines: fuelLines,
    bodyTextPreview: bodyText.slice(0, 5000),
  });
}
