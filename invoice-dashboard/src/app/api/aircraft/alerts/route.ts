import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { TRIPS } from "@/lib/maintenanceData";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // Allow up to 2 min for nuke (many alerts to list+delete)

const FA_BASE = "https://aeroapi.flightaware.com/aeroapi";

function faHeaders() {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) throw new Error("FLIGHTAWARE_API_KEY not set");
  return {
    "x-apikey": key,
    "Content-Type": "application/json; charset=UTF-8",
    Accept: "application/json; charset=UTF-8",
  };
}

/** Extract alerts array from FA API response, handling various formats */
function extractAlerts(data: unknown): { id: number }[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Try common field names
    for (const key of ["alerts", "data", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as { id: number }[];
    }
    // If the object has an "id" field, it might be a single alert
    if ("id" in obj) return [obj as unknown as { id: number }];
  }
  return [];
}

/**
 * GET /api/aircraft/alerts — list current FA alert registrations
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // Get active registrations from our DB
  const supa = createServiceClient();
  const { data: registrations } = await supa
    .from("fa_alert_registrations")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });

  // Also fetch current alerts from FA API
  let faAlerts = null;
  let faRaw = null;
  try {
    const res = await fetch(`${FA_BASE}/alerts`, {
      headers: faHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      faRaw = await res.json();
      faAlerts = extractAlerts(faRaw);
    }
  } catch { /* ignore */ }

  return NextResponse.json({
    registrations: registrations ?? [],
    fa_alerts: faAlerts,
    fa_raw_keys: faRaw ? Object.keys(faRaw) : null,
    fa_raw_type: faRaw === null ? "null" : Array.isArray(faRaw) ? "array" : typeof faRaw,
    fa_alert_count: faAlerts?.length ?? 0,
  });
}

/**
 * POST /api/aircraft/alerts — register FA webhook alerts for all fleet tails
 *
 * Body: { action: "setup" | "teardown" | "refresh" }
 *
 * - setup: Register webhook endpoint + create alerts for all tails
 * - teardown: Delete all alerts
 * - refresh: Delete stale alerts, create missing ones
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({ error: "FLIGHTAWARE_API_KEY not configured" }, { status: 503 });
  }

  const webhookSecret = process.env.FLIGHTAWARE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "FLIGHTAWARE_WEBHOOK_SECRET not configured" }, { status: 503 });
  }

  let body: { action?: string; base_url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = body.action ?? "refresh";
  const supa = createServiceClient();

  // Webhook URL: caller provides base_url, or fall back to env / Vercel auto-detect
  const baseUrl = body.base_url
    ?? process.env.WEBHOOK_BASE_URL
    ?? process.env.NEXT_PUBLIC_SITE_URL
    ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
    ?? process.env.VERCEL_URL;

  if (!baseUrl) {
    return NextResponse.json({
      error: "Provide base_url in request body (e.g. https://baker-ai-gamma.vercel.app)",
    }, { status: 400 });
  }

  const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const webhookUrl = `${normalizedBase}/api/aircraft/webhook?secret=${encodeURIComponent(webhookSecret)}`;

  const results: { action: string; details: unknown[] } = { action, details: [] };

  // "nuke" = delete ALL alerts from FA (DB + API), ignoring what's in our DB
  if (action === "nuke" || action === "teardown") {
    return await nukeAlerts(supa, webhookUrl, webhookSecret, results);
  }

  // Step 1: Register webhook endpoint with FA FIRST (needed before listing alerts)
  try {
    const endpointRes = await fetch(`${FA_BASE}/alerts/endpoint`, {
      method: "PUT",
      headers: faHeaders(),
      body: JSON.stringify({ url: webhookUrl }),
      signal: AbortSignal.timeout(10000),
    });

    if (!endpointRes.ok) {
      const errText = await endpointRes.text();
      return NextResponse.json({
        error: "Failed to register webhook endpoint with FlightAware",
        status: endpointRes.status,
        detail: errText,
      }, { status: 502 });
    }

    results.details.push({ step: "endpoint_registered", url: webhookUrl.replace(webhookSecret, "***") });
    console.log("[FA Alerts] Webhook endpoint registered");
  } catch (err) {
    return NextResponse.json({
      error: "Failed to connect to FlightAware",
      detail: String(err),
    }, { status: 502 });
  }

  // Step 1b: For setup, delete ALL existing alerts from FA (now that endpoint is registered)
  if (action === "setup") {
    try {
      const listRes = await fetch(`${FA_BASE}/alerts`, { headers: faHeaders(), signal: AbortSignal.timeout(10000) });
      if (listRes.ok) {
        const listRaw = await listRes.json();
        const allAlerts = extractAlerts(listRaw);
        console.log(`[FA Alerts] Listed ${allAlerts.length} alerts (raw type: ${Array.isArray(listRaw) ? "array" : typeof listRaw}, keys: ${Object.keys(listRaw ?? {})})`);

        let cleaned = 0;
        for (let i = 0; i < allAlerts.length; i += 5) {
          const batch = allAlerts.slice(i, i + 5);
          const delResults = await Promise.allSettled(
            batch.map((alert) =>
              fetch(`${FA_BASE}/alerts/${alert.id}`, { method: "DELETE", headers: faHeaders(), signal: AbortSignal.timeout(10000) })
            )
          );
          cleaned += delResults.filter((r) => r.status === "fulfilled").length;
        }
        // Clear our DB registrations too
        await supa.from("fa_alert_registrations").update({ active: false }).eq("active", true);
        results.details.push({ step: "cleanup", deleted: cleaned, total_found: allAlerts.length, raw_type: Array.isArray(listRaw) ? "array" : typeof listRaw });
        console.log(`[FA Alerts] Setup cleanup: deleted ${cleaned}/${allAlerts.length} existing alerts`);
      } else {
        const errText = await listRes.text();
        results.details.push({ step: "cleanup_list_failed", status: listRes.status, error: errText });
      }
    } catch (err) {
      results.details.push({ step: "cleanup_error", error: String(err) });
    }
  }

  // Step 2: Get fleet tail numbers
  const now = new Date();
  const past = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const future = new Date(now.getTime() + 48 * 3600_000).toISOString();

  const { data: dbFlights } = await supa
    .from("flights")
    .select("tail_number")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const dbTails = [...new Set(
    (dbFlights ?? [])
      .map((f) => f.tail_number as string | null)
      .filter((t): t is string => !!t),
  )];

  const fallbackTails = [...new Set(TRIPS.map((t) => t.tail))];
  const tails = dbTails.length > 0 ? dbTails : fallbackTails;

  // Step 3: Get existing alert registrations
  const { data: existingRegs } = await supa
    .from("fa_alert_registrations")
    .select("tail, alert_id")
    .eq("active", true);

  const existingTails = new Set((existingRegs ?? []).map((r) => r.tail));

  // For refresh: only create alerts for tails that don't have one
  const tailsToRegister = action === "setup"
    ? tails
    : tails.filter((t) => !existingTails.has(t));

  // Step 4: Create alerts for each tail
  let created = 0;
  let failed = 0;

  for (const tail of tailsToRegister) {
    try {
      const alertRes = await fetch(`${FA_BASE}/alerts`, {
        method: "POST",
        headers: faHeaders(),
        body: JSON.stringify({
          ident: tail,
          origin: null,
          destination: null,
          aircraft_type: null,
          start: null,
          end: null,
          max_weekly: 50,
          events: {
            arrival: false,
            departure: false,
            cancelled: true,
            diverted: true,
            filed: false,
          },
          target_url: webhookUrl,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const responseText = await alertRes.text();

      if (alertRes.ok) {
        // FA may return empty body or JSON with alert ID
        let alertId: number | null = null;
        if (responseText) {
          try {
            const alertData = JSON.parse(responseText);
            alertId = alertData.id ?? alertData.alert_id ?? null;
          } catch { /* empty or non-JSON response — alert still created */ }
        }

        // Try to get alert ID from Location header if not in body
        const location = alertRes.headers.get("location");
        if (!alertId && location) {
          const match = location.match(/\/alerts\/(\d+)/);
          if (match) alertId = parseInt(match[1], 10);
        }

        if (alertId) {
          await supa.from("fa_alert_registrations").upsert(
            { tail, alert_id: alertId, active: true },
            { onConflict: "tail" },
          );
        }

        created++;
        results.details.push({ step: "alert_created", tail, alert_id: alertId, status: alertRes.status });
        console.log(`[FA Alerts] Created alert for ${tail} (id: ${alertId}, status: ${alertRes.status})`);
      } else {
        failed++;
        results.details.push({ step: "alert_failed", tail, status: alertRes.status, error: responseText });
        console.warn(`[FA Alerts] Failed to create alert for ${tail}: ${alertRes.status} ${responseText}`);
      }

      // Rate limit: brief pause between calls
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      failed++;
      results.details.push({ step: "alert_error", tail, error: String(err) });
    }
  }

  return NextResponse.json({
    ...results,
    summary: {
      total_tails: tails.length,
      already_registered: existingTails.size,
      created,
      failed,
    },
  });
}

/**
 * Nuke all alerts: register endpoint first, then list from FA API and delete everything.
 * Falls back to DB-based deletion if API listing returns empty.
 */
async function nukeAlerts(
  supa: ReturnType<typeof createServiceClient>,
  webhookUrl: string,
  webhookSecret: string,
  results: { action: string; details: unknown[] },
) {
  // Step 1: Register endpoint so FA returns our alerts in the listing
  try {
    const endpointRes = await fetch(`${FA_BASE}/alerts/endpoint`, {
      method: "PUT",
      headers: faHeaders(),
      body: JSON.stringify({ url: webhookUrl }),
      signal: AbortSignal.timeout(10000),
    });
    results.details.push({
      step: "endpoint_registered",
      status: endpointRes.status,
      url: webhookUrl.replace(webhookSecret, "***"),
    });
    console.log(`[FA Alerts] Nuke: endpoint registered (${endpointRes.status})`);
  } catch (err) {
    results.details.push({ step: "endpoint_error", error: String(err) });
    console.warn("[FA Alerts] Nuke: endpoint registration failed:", err);
  }

  // Step 2: List all alerts from FA API (long timeout — may have hundreds)
  let faAlerts: { id: number }[] = [];
  try {
    const listRes = await fetch(`${FA_BASE}/alerts`, {
      headers: faHeaders(),
      signal: AbortSignal.timeout(60000),
    });

    if (listRes.ok) {
      const listRaw = await listRes.json();
      faAlerts = extractAlerts(listRaw);
      results.details.push({
        step: "listed_fa_alerts",
        count: faAlerts.length,
        raw_type: Array.isArray(listRaw) ? "array" : typeof listRaw,
        raw_keys: listRaw && typeof listRaw === "object" && !Array.isArray(listRaw) ? Object.keys(listRaw) : null,
        sample: faAlerts.slice(0, 3),
      });
      console.log(`[FA Alerts] Nuke: found ${faAlerts.length} alerts from FA API`);
    } else {
      const errText = await listRes.text();
      results.details.push({ step: "list_failed", status: listRes.status, error: errText });
    }
  } catch (err) {
    results.details.push({ step: "list_error", error: String(err) });
  }

  // Step 3: Also get alert IDs from our DB (in case FA listing misses some)
  const { data: dbRegs } = await supa
    .from("fa_alert_registrations")
    .select("tail, alert_id")
    .eq("active", true);

  const dbAlertIds = new Set((dbRegs ?? []).map((r) => r.alert_id));
  const faAlertIds = new Set(faAlerts.map((a) => a.id));

  // Merge: all FA alert IDs + any DB-only alert IDs
  const allIds = [...new Set([...faAlertIds, ...dbAlertIds])].filter((id) => id != null);
  results.details.push({
    step: "merged_alert_ids",
    from_fa: faAlertIds.size,
    from_db: dbAlertIds.size,
    total_unique: allIds.length,
  });

  // Step 4: Delete all alerts
  let deleted = 0;
  let failed = 0;
  const errors: { id: number; status: number; error: string }[] = [];

  for (let i = 0; i < allIds.length; i += 5) {
    const batch = allIds.slice(i, i + 5);
    const delResults = await Promise.allSettled(
      batch.map(async (alertId) => {
        const res = await fetch(`${FA_BASE}/alerts/${alertId}`, {
          method: "DELETE",
          headers: faHeaders(),
          signal: AbortSignal.timeout(10000),
        });
        return { alertId, status: res.status, ok: res.ok || res.status === 404 };
      })
    );

    for (const result of delResults) {
      if (result.status === "fulfilled" && result.value.ok) {
        deleted++;
      } else {
        failed++;
        if (result.status === "fulfilled") {
          errors.push({ id: result.value.alertId, status: result.value.status, error: "delete failed" });
        } else {
          errors.push({ id: 0, status: 0, error: String(result.reason) });
        }
      }
    }

    // Brief pause between batches
    if (i + 5 < allIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Step 5: Clear DB registrations
  await supa.from("fa_alert_registrations").update({ active: false }).eq("active", true);

  if (errors.length > 0) {
    results.details.push({ step: "delete_errors", errors: errors.slice(0, 10) });
  }

  console.log(`[FA Alerts] Nuke complete: deleted ${deleted}, failed ${failed}`);

  return NextResponse.json({
    ...results,
    summary: { deleted, failed, total_found: allIds.length },
  });
}
