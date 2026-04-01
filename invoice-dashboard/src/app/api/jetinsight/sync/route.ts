import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import {
  runFullSync,
  syncCrewIndex,
  syncCrewDocs,
  syncAircraftDocs,
} from "@/lib/jetinsight/scraper";

export const maxDuration = 300; // Vercel Pro: 5 min max

/**
 * POST /api/jetinsight/sync — Trigger a JetInsight sync
 * Body: { type: "full" | "crew_index" | "crew_docs" | "aircraft_docs", entityId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  // Rate limit: 1 sync per 60 seconds
  if (await isRateLimited(auth.userId, 1, 60_000)) {
    return NextResponse.json(
      { error: "Sync already in progress. Please wait 60 seconds." },
      { status: 429 },
    );
  }

  let body: { type?: string; entityId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const syncType = body.type ?? "full";
  const supa = createServiceClient();

  // Get session cookie
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    return NextResponse.json(
      { error: "No session cookie configured. Paste one in the JetInsight config." },
      { status: 400 },
    );
  }

  try {
    if (syncType === "full") {
      const result = await runFullSync(auth.userId);
      return NextResponse.json({ ok: true, result });
    }

    if (syncType === "crew_index") {
      const crew = await syncCrewIndex(cookie);
      return NextResponse.json({ ok: true, crew, count: crew.length });
    }

    if (syncType === "crew_docs" && body.entityId) {
      // entityId = pilot_profile.id, need to look up jetinsight_uuid
      const { data: profile } = await supa
        .from("pilot_profiles")
        .select("id, jetinsight_uuid")
        .eq("id", body.entityId)
        .single();

      if (!profile?.jetinsight_uuid) {
        return NextResponse.json(
          { error: "Pilot not linked to JetInsight" },
          { status: 400 },
        );
      }

      const result = await syncCrewDocs(
        String(profile.id),
        profile.jetinsight_uuid,
        cookie,
      );
      return NextResponse.json({ ok: true, result });
    }

    if (syncType === "aircraft_docs" && body.entityId) {
      const result = await syncAircraftDocs(body.entityId, cookie);
      return NextResponse.json({ ok: true, result });
    }

    return NextResponse.json(
      { error: `Unknown sync type: ${syncType}` },
      { status: 400 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[jetinsight/sync] error:", msg);

    if (msg === "SESSION_EXPIRED") {
      return NextResponse.json(
        { error: "JetInsight session expired. Please paste a new cookie." },
        { status: 401 },
      );
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
