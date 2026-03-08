import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { TRIPS } from "@/lib/maintenanceData";

export const dynamic = "force-dynamic";

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
  try {
    const res = await fetch(`${FA_BASE}/alerts`, {
      headers: faHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      faAlerts = await res.json();
    }
  } catch { /* ignore */ }

  return NextResponse.json({
    registrations: registrations ?? [],
    fa_alerts: faAlerts,
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

  if (action === "teardown") {
    return await teardownAlerts(supa, results);
  }

  // For setup: delete ALL existing alerts from FA first (including orphaned ones not in our DB)
  if (action === "setup") {
    try {
      const listRes = await fetch(`${FA_BASE}/alerts`, { headers: faHeaders(), signal: AbortSignal.timeout(10000) });
      if (listRes.ok) {
        const listData = await listRes.json();
        const allAlerts = listData.alerts ?? [];
        let cleaned = 0;
        for (const alert of allAlerts) {
          try {
            await fetch(`${FA_BASE}/alerts/${alert.id}`, { method: "DELETE", headers: faHeaders(), signal: AbortSignal.timeout(10000) });
            cleaned++;
            await new Promise((r) => setTimeout(r, 300));
          } catch { /* ignore */ }
        }
        // Clear our DB registrations too
        await supa.from("fa_alert_registrations").update({ active: false }).eq("active", true);
        results.details.push({ step: "cleanup", deleted: cleaned, total_found: allAlerts.length });
        console.log(`[FA Alerts] Setup cleanup: deleted ${cleaned}/${allAlerts.length} existing alerts`);
      }
    } catch (err) {
      results.details.push({ step: "cleanup_error", error: String(err) });
    }
  }

  // Step 1: Register webhook endpoint with FA
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
          max_weekly: 1000,
          events: {
            arrival: true,
            departure: true,
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

      // Rate limit: pause between calls
      await new Promise((r) => setTimeout(r, 500));
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

async function teardownAlerts(
  supa: ReturnType<typeof createServiceClient>,
  results: { action: string; details: unknown[] },
) {
  // Get all active registrations
  const { data: regs } = await supa
    .from("fa_alert_registrations")
    .select("tail, alert_id")
    .eq("active", true);

  let deleted = 0;
  let failed = 0;

  for (const reg of regs ?? []) {
    try {
      const res = await fetch(`${FA_BASE}/alerts/${reg.alert_id}`, {
        method: "DELETE",
        headers: faHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok || res.status === 404) {
        await supa
          .from("fa_alert_registrations")
          .update({ active: false })
          .eq("alert_id", reg.alert_id);
        deleted++;
        results.details.push({ step: "alert_deleted", tail: reg.tail, alert_id: reg.alert_id });
      } else {
        failed++;
        results.details.push({ step: "delete_failed", tail: reg.tail, status: res.status });
      }

      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      failed++;
      results.details.push({ step: "delete_error", tail: reg.tail, error: String(err) });
    }
  }

  return NextResponse.json({
    ...results,
    summary: { deleted, failed },
  });
}
