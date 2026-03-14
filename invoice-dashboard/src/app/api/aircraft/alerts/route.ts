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
 * Nuke all alerts using paginated delete loop.
 * GET /alerts times out when there are 1000+ alerts, so we fetch one page
 * at a time (max_pages=1), delete those, and repeat until clean.
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
  } catch (err) {
    results.details.push({ step: "endpoint_error", error: String(err) });
  }

  // Step 2: Paginated delete loop — fetch one page, delete, repeat
  let totalDeleted = 0;
  let totalFailed = 0;
  let rounds = 0;
  const MAX_ROUNDS = 100; // Safety limit (~1500 alerts at 15/page)

  while (rounds < MAX_ROUNDS) {
    rounds++;

    // Try to list one page of alerts
    let alerts: { id: number }[] = [];
    let listError: string | null = null;

    try {
      const listRes = await fetch(`${FA_BASE}/alerts?max_pages=1`, {
        headers: faHeaders(),
        signal: AbortSignal.timeout(30000),
      });

      if (listRes.ok) {
        const raw = await listRes.json();
        alerts = extractAlerts(raw);

        // First round: log diagnostic info
        if (rounds === 1) {
          results.details.push({
            step: "first_page",
            count: alerts.length,
            raw_type: Array.isArray(raw) ? "array" : typeof raw,
            raw_keys: raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : null,
            sample: alerts.slice(0, 2),
          });
        }
      } else {
        listError = `${listRes.status}: ${await listRes.text()}`;
      }
    } catch (err) {
      listError = String(err);
    }

    // If listing failed or returned 0, we're done (or stuck)
    if (listError) {
      results.details.push({ step: "list_error", round: rounds, error: listError });
      break;
    }

    if (alerts.length === 0) {
      results.details.push({ step: "all_clear", rounds_taken: rounds });
      break;
    }

    // Delete this batch
    let batchDeleted = 0;
    for (let i = 0; i < alerts.length; i += 5) {
      const batch = alerts.slice(i, i + 5);
      const delResults = await Promise.allSettled(
        batch.map(async (alert) => {
          const res = await fetch(`${FA_BASE}/alerts/${alert.id}`, {
            method: "DELETE",
            headers: faHeaders(),
            signal: AbortSignal.timeout(10000),
          });
          return { ok: res.ok || res.status === 404 };
        })
      );

      for (const r of delResults) {
        if (r.status === "fulfilled" && r.value.ok) {
          batchDeleted++;
          totalDeleted++;
        } else {
          totalFailed++;
        }
      }
    }

    console.log(`[FA Alerts] Nuke round ${rounds}: listed ${alerts.length}, deleted ${batchDeleted}`);

    // Brief pause between rounds
    await new Promise((r) => setTimeout(r, 300));
  }

  // Step 3: Also delete any DB-tracked alerts that FA listing might have missed
  const { data: dbRegs } = await supa
    .from("fa_alert_registrations")
    .select("alert_id")
    .eq("active", true);

  for (const reg of dbRegs ?? []) {
    try {
      const res = await fetch(`${FA_BASE}/alerts/${reg.alert_id}`, {
        method: "DELETE",
        headers: faHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok || res.status === 404) totalDeleted++;
    } catch { /* ignore */ }
  }

  // Step 4: Clear all DB registrations
  await supa.from("fa_alert_registrations").update({ active: false }).eq("active", true);

  console.log(`[FA Alerts] Nuke complete: ${totalDeleted} deleted, ${totalFailed} failed, ${rounds} rounds`);

  return NextResponse.json({
    ...results,
    summary: { deleted: totalDeleted, failed: totalFailed, rounds },
  });
}
