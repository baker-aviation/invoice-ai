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
 * Register FA webhook alerts for any tails that don't have one yet.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function refreshAlerts(tails: string[]): Promise<void> {
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

  try {
    const supa = createServiceClient();

    // Get tails that already have active alerts
    const { data: existing } = await supa
      .from("fa_alert_registrations")
      .select("tail")
      .eq("active", true);

    const registered = new Set((existing ?? []).map((r) => r.tail));
    const missing = tails.filter((t) => !registered.has(t));

    if (missing.length === 0) return;

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
            max_weekly: 1000,
            events: {
              arrival: true,
              departure: true,
              cancelled: true,
              diverted: true,
              filed: true,
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
