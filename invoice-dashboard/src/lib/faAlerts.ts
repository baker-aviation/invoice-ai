import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

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
 * Last time we checked for unregistered tails.
 * Only run once every 30 minutes to avoid hammering FA.
 */
let lastRefreshMs = 0;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min — check for unregistered tails periodically

/**
 * Register FA webhook alerts for active tails (flights in next 48h) and
 * deregister alerts for idle tails to reduce push delivery costs.
 * Fire-and-forget — errors are logged but don't propagate.
 *
 * @param tails      Full fleet tail list (unused, kept for backwards compat)
 * @param activeTails Tails with flights in the next 48h — only these get alerts
 */
export async function refreshAlerts(tails: string[], activeTails: string[]): Promise<void> {
  // Skip if checked recently
  if (Date.now() - lastRefreshMs < REFRESH_INTERVAL_MS) {
    console.log("[FA Alerts] Skipped — checked", Math.round((Date.now() - lastRefreshMs) / 60000), "min ago");
    return;
  }
  lastRefreshMs = Date.now();

  const apiKey = process.env.FLIGHTAWARE_API_KEY?.trim();
  const webhookSecret = process.env.FLIGHTAWARE_WEBHOOK_SECRET?.trim();
  const baseUrl = process.env.WEBHOOK_BASE_URL?.trim();

  if (!apiKey || !webhookSecret || !baseUrl) {
    console.warn("[FA Alerts] Missing env vars:", {
      hasApiKey: !!apiKey,
      hasWebhookSecret: !!webhookSecret,
      hasBaseUrl: !!baseUrl,
    });
    return;
  }

  // Only register alerts from production to prevent duplicate registrations
  // across dev/preview deployments
  if (!baseUrl.includes("baker-ai-gamma")) {
    console.log("[FA Alerts] Skipped — not production (base:", baseUrl, ")");
    return;
  }

  try {
    const supa = createServiceClient();
    const activeSet = new Set(activeTails);

    // Get all tails that currently have active alerts
    const { data: existing } = await supa
      .from("fa_alert_registrations")
      .select("tail, alert_id")
      .eq("active", true);

    const registeredRows = existing ?? [];
    const registeredSet = new Set(registeredRows.map((r) => r.tail));

    // --- Deregister idle tails (active in DB but not in activeTails) ---
    const toDeregister = registeredRows.filter((r) => !activeSet.has(r.tail));
    if (toDeregister.length > 0) {
      console.log(`[FA Alerts] Deregistering ${toDeregister.length} idle tails: ${toDeregister.map((r) => r.tail).join(", ")}`);
    }

    for (const row of toDeregister) {
      try {
        const res = await fetch(`${FA_BASE}/alerts/${row.alert_id}`, {
          method: "DELETE",
          headers: faHeaders(),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok || res.status === 404) {
          // 404 means already deleted on FA side — still mark inactive locally
          await supa
            .from("fa_alert_registrations")
            .update({ active: false })
            .eq("tail", row.tail);
          console.log(`[FA Alerts] Deregistered ${row.tail} (alert ${row.alert_id})`);
        } else {
          console.warn(`[FA Alerts] Deregister failed for ${row.tail}: ${res.status}`);
        }

        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        console.warn(`[FA Alerts] Deregister error for ${row.tail}:`, err);
      }
    }

    // --- Register active tails that don't have alerts yet ---
    const missing = activeTails.filter((t) => !registeredSet.has(t));

    if (missing.length === 0) {
      console.log(`[FA Alerts] All ${activeTails.length} active tails already registered`);
      return;
    }

    console.log(`[FA Alerts] Auto-registering ${missing.length} new tails: ${missing.join(", ")}`);

    const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
    const webhookUrl = `${normalizedBase}/api/aircraft/webhook?secret=${encodeURIComponent(webhookSecret)}`;

    for (const tail of missing) {
      try {
        const res = await fetch(`${FA_BASE}/alerts`, {
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

        const responseText = await res.text();

        if (res.ok) {
          let alertId: number | null = null;
          if (responseText) {
            try {
              const data = JSON.parse(responseText);
              alertId = data.id ?? data.alert_id ?? null;
            } catch { /* empty response */ }
          }
          const location = res.headers.get("location");
          if (!alertId && location) {
            const match = location.match(/\/alerts\/(\d+)/);
            if (match) alertId = parseInt(match[1], 10);
          }

          if (alertId) {
            const { error: upsertErr } = await supa.from("fa_alert_registrations").upsert(
              { tail, alert_id: alertId, active: true },
              { onConflict: "tail" },
            );
            if (upsertErr) {
              console.error(`[FA Alerts] DB upsert failed for ${tail}:`, upsertErr.message);
            }
          }
          console.log(`[FA Alerts] Auto-registered ${tail} (id: ${alertId})`);
        } else {
          console.warn(`[FA Alerts] Auto-register failed for ${tail}: ${res.status}`);
        }

        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        console.warn(`[FA Alerts] Auto-register error for ${tail}:`, err);
      }
    }
  } catch (err) {
    console.warn("[FA Alerts] refreshAlerts error:", err);
  }
}
