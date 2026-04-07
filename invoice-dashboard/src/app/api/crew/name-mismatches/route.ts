import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getSheetData } from "@/lib/googleSheets";
import { parseWeeklySheetRows } from "@/lib/crewInfoParser";
import { matchNameFuzzy, suggestMatches, normalizeName, type NameCandidate } from "@/lib/nameResolver";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/name-mismatches?sheet_name=APR%208-APR%2016%20(A)
 * Parses the sheet, matches names against crew_members + aliases,
 * returns unmatched names with suggested matches.
 */
export async function GET(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  const sheetName = req.nextUrl.searchParams.get("sheet_name");
  if (!sheetName) {
    return NextResponse.json({ error: "sheet_name query param required" }, { status: 400 });
  }

  try {
    const supa = createServiceClient();

    // Fetch sheet data and crew members in parallel
    const [rows, crewRes, aliasRes] = await Promise.all([
      getSheetData(sheetName),
      supa.from("crew_members")
        .select("id, name, jetinsight_name, slack_user_id, role")
        .eq("active", true),
      supa.from("crew_name_aliases")
        .select("crew_member_id, source, alias_name, normalized_name"),
    ]);

    const crewMembers = crewRes.data ?? [];
    const aliases = aliasRes.data ?? [];

    // Parse sheet to extract names
    const errors: string[] = [];
    const entries = parseWeeklySheetRows(rows, errors);

    // Build alias lookup: normalized_name → crew_member_id
    const aliasLookup = new Map<string, string>();
    for (const a of aliases) {
      aliasLookup.set(a.normalized_name, a.crew_member_id);
    }

    // Build candidate list for fuzzy matching
    const candidates: NameCandidate[] = crewMembers.map((c) => ({
      id: c.id,
      name: c.name,
      alt_name: c.jetinsight_name,
    }));

    const matched: Array<{ sheet_name: string; crew_member_id: string; crew_name: string; method: string }> = [];
    const unmatched: Array<{
      sheet_name: string;
      direction: string;
      role: string;
      suggestions: Array<{ id: string; name: string; confidence: number }>;
    }> = [];

    const seen = new Set<string>();

    for (const entry of entries) {
      const normalized = normalizeName(entry.name);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // 1. Check alias table
      const aliasMatch = aliasLookup.get(normalized);
      if (aliasMatch) {
        const crew = crewMembers.find((c) => c.id === aliasMatch);
        if (crew) {
          matched.push({ sheet_name: entry.name, crew_member_id: crew.id, crew_name: crew.name, method: "alias" });
          continue;
        }
      }

      // 2. Fuzzy match
      const fuzzy = matchNameFuzzy(entry.name, candidates);
      if (fuzzy && fuzzy.confidence >= 50) {
        matched.push({ sheet_name: entry.name, crew_member_id: fuzzy.id, crew_name: fuzzy.name, method: `fuzzy (${fuzzy.confidence}%)` });
        continue;
      }

      // 3. Unmatched — provide suggestions
      const suggestions = suggestMatches(entry.name, candidates, 5);
      unmatched.push({
        sheet_name: entry.name,
        direction: entry.direction,
        role: entry.role,
        suggestions,
      });
    }

    return NextResponse.json({
      sheet_name: sheetName,
      total_names: entries.length,
      matched_count: matched.length,
      unmatched_count: unmatched.length,
      matched,
      unmatched,
      parse_errors: errors,
      _debug: {
        crew_members_count: crewMembers.length,
        aliases_count: aliases.length,
        crew_query_error: crewRes.error?.message ?? null,
        alias_query_error: aliasRes.error?.message ?? null,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to check mismatches" },
      { status: 500 },
    );
  }
}
