import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const SAMSARA_BASE = "https://api.samsara.com";
const SLACK_CHANNEL = "C0AR2R54BPC"; // #vehicles

// ── Samsara types ──────────────────────────────────────────────────────────

interface SamsaraVehicle {
  id: string;
  name?: string;
}

interface SamsaraVehicleStat {
  id: string;
  name?: string;
  faultCodes?: { value?: unknown; time?: string };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchAllVehicles(apiKey: string): Promise<SamsaraVehicle[]> {
  const vehicles: SamsaraVehicle[] = [];
  let url: string | null = `${SAMSARA_BASE}/fleet/vehicles?limit=200`;
  let page = 0;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Samsara vehicles HTTP ${res.status}`);
    const json = await res.json();
    vehicles.push(...(json.data ?? []));
    if (json.pagination?.hasNextPage && json.pagination?.endCursor) {
      url = `${SAMSARA_BASE}/fleet/vehicles?limit=200&after=${encodeURIComponent(json.pagination.endCursor)}`;
    } else {
      url = null;
    }
    if (++page > 10) break;
  }
  return vehicles;
}

async function fetchFaultStats(apiKey: string): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  let url: string | null = `${SAMSARA_BASE}/fleet/vehicles/stats?types=faultCodes&limit=200`;
  let page = 0;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) break;
    const json = await res.json();
    for (const v of (json.data ?? []) as SamsaraVehicleStat[]) {
      const fcVal = v.faultCodes?.value;
      let hasActive = false;
      if (Array.isArray(fcVal)) {
        hasActive = fcVal.length > 0;
      } else if (fcVal && typeof fcVal === "object") {
        const obj = fcVal as Record<string, unknown[]>;
        hasActive = (obj.activeCodes ?? obj.activeDtcIds ?? []).length > 0;
      }
      map.set(v.id, hasActive);
    }
    if (json.pagination?.hasNextPage && json.pagination?.endCursor) {
      url = `${SAMSARA_BASE}/fleet/vehicles/stats?types=faultCodes&limit=200&after=${encodeURIComponent(json.pagination.endCursor)}`;
    } else {
      url = null;
    }
    if (++page > 10) break;
  }
  return map;
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "SAMSARA_API_KEY not configured" }, { status: 503 });
  }

  const supa = createServiceClient();

  // 1. Fetch current vehicles + fault codes from Samsara
  const [liveVehicles, faultMap] = await Promise.all([
    fetchAllVehicles(apiKey),
    fetchFaultStats(apiKey),
  ]);

  const liveIds = new Set(liveVehicles.map((v) => v.id));

  // 2. Load known vehicles from DB
  const { data: knownRows } = await supa
    .from("samsara_vehicles")
    .select("samsara_id, name, removed_at, check_engine");
  const known = new Map(
    (knownRows ?? []).map((r) => [r.samsara_id, r]),
  );

  const added: SamsaraVehicle[] = [];
  const returned: SamsaraVehicle[] = [];
  const newCheckEngine: string[] = [];
  const clearedCheckEngine: string[] = [];
  const now = new Date().toISOString();

  // 3. Diff: new or returned vehicles
  for (const v of liveVehicles) {
    const existing = known.get(v.id);
    if (!existing) {
      added.push(v);
      await supa.from("samsara_vehicles").insert({
        samsara_id: v.id,
        name: v.name ?? null,
        first_seen_at: now,
        last_seen_at: now,
        check_engine: faultMap.get(v.id) ?? false,
      });
    } else {
      // Vehicle exists — update last_seen and check for return
      if (existing.removed_at) {
        returned.push(v);
      }
      const hasEngine = faultMap.get(v.id) ?? false;
      if (hasEngine && !existing.check_engine) {
        newCheckEngine.push(v.name ?? v.id);
      } else if (!hasEngine && existing.check_engine) {
        clearedCheckEngine.push(v.name ?? v.id);
      }
      await supa
        .from("samsara_vehicles")
        .update({
          name: v.name ?? existing.name,
          last_seen_at: now,
          removed_at: null,
          check_engine: hasEngine,
        })
        .eq("samsara_id", v.id);
    }
  }

  // 4. Detect removed vehicles (in DB but not in Samsara)
  const removed: string[] = [];
  for (const [sid, row] of known) {
    if (!liveIds.has(sid) && !row.removed_at) {
      removed.push(row.name ?? sid);
      await supa
        .from("samsara_vehicles")
        .update({ removed_at: now })
        .eq("samsara_id", sid);
    }
  }

  // 5. Slack alerts
  const blocks: Record<string, unknown>[] = [];

  if (added.length > 0) {
    const names = added.map((v) => v.name ?? v.id).join(", ");
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `:new: *New vehicle${added.length > 1 ? "s" : ""} detected in Samsara:*\n${names}` } },
    );
  }

  if (returned.length > 0) {
    const names = returned.map((v) => v.name ?? v.id).join(", ");
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `:leftwards_arrow_with_hook: *Vehicle${returned.length > 1 ? "s" : ""} back online:*\n${names}` } },
    );
  }

  if (removed.length > 0) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `:x: *Vehicle${removed.length > 1 ? "s" : ""} no longer in Samsara:*\n${removed.join(", ")}` } },
    );
  }

  if (newCheckEngine.length > 0) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `:warning: *Check engine light ON:*\n${newCheckEngine.join(", ")}` } },
    );
  }

  if (clearedCheckEngine.length > 0) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *Check engine light cleared:*\n${clearedCheckEngine.join(", ")}` } },
    );
  }

  if (blocks.length > 0) {
    blocks.unshift({ type: "header", text: { type: "plain_text", text: "Samsara Fleet Update" } });
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (slackToken) {
      const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: SLACK_CHANNEL, text: "Samsara fleet change detected", blocks }),
      });
      const slackData = await slackRes.json();
      if (!slackData.ok) console.error("[samsara-vehicle-sync] Slack error:", slackData.error);
    } else {
      console.warn("[samsara-vehicle-sync] SLACK_BOT_TOKEN not set — skipping Slack");
    }
  }

  const summary = {
    live: liveVehicles.length,
    added: added.length,
    returned: returned.length,
    removed: removed.length,
    newCheckEngine: newCheckEngine.length,
    clearedCheckEngine: clearedCheckEngine.length,
  };
  console.log("[samsara-vehicle-sync]", summary);

  return NextResponse.json({ ok: true, ...summary });
}
