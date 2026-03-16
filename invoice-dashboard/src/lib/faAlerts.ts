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
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min

type FaAlert = {
  id: number;
  ident: string;
  origin: string | null;
  destination: string | null;
  target_url: string | null;
  enabled: boolean;
};

/**
 * Fetch ALL alerts currently registered on FA's side.
 * This is the source of truth — our DB can get out of sync.
 */
async function listFaAlerts(): Promise<FaAlert[]> {
  const alerts: FaAlert[] = [];
  let url: string | null = `${FA_BASE}/alerts`;

  for (let page = 0; page < 10 && url; page++) {
    try {
      const resp: Response = await fetch(url, {
        headers: faHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        console.warn(`[FA Alerts] List alerts failed: ${resp.status}`);
        break;
      }
      const body: { alerts?: FaAlert[]; links?: { next?: string } } = await resp.json();
      alerts.push(...(body.alerts ?? []));
      url = body.links?.next
        ? (body.links!.next!.startsWith("http") ? body.links!.next! : `${FA_BASE}${body.links!.next!}`)
        : null;
    } catch (err) {
      console.warn("[FA Alerts] List alerts error:", err);
      break;
    }
  }

  return alerts;
}

/**
 * Register FA webhook alerts for active tails (flights in next 48h) and
 * deregister alerts for idle tails to reduce push delivery costs.
 *
 * Syncs against FA's actual alert list to prevent duplicate registrations.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function refreshAlerts(tails: string[], activeTails: string[], callsignMap?: Map<string, string>): Promise<void> {
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

  // Only register alerts from production
  if (!baseUrl.includes("baker-ai-gamma")) {
    console.log("[FA Alerts] Skipped — not production (base:", baseUrl, ")");
    return;
  }

  try {
    const supa = createServiceClient();
    const activeSet = new Set(activeTails);

    // Build reverse callsign map: callsign → tail (e.g. KOW733 → N733FL)
    const callsignToTail = new Map<string, string>();
    if (callsignMap) {
      for (const [tail, cs] of callsignMap) callsignToTail.set(cs, tail);
    }

    // ── Step 1: Get FA's actual alert list (source of truth) ──
    const faAlerts = await listFaAlerts();
    console.log(`[FA Alerts] FA has ${faAlerts.length} alerts registered`);

    // Map ident → alert(s) on FA side. An ident could be N-number or callsign.
    // Resolve to tail number for comparison with our active set.
    const alertsByTail = new Map<string, FaAlert[]>();
    for (const alert of faAlerts) {
      // Resolve ident to tail: could be "N733FL" or "KOW733"
      const tail = callsignToTail.get(alert.ident) ?? alert.ident;
      const existing = alertsByTail.get(tail) ?? [];
      existing.push(alert);
      alertsByTail.set(tail, existing);
    }

    // ── Step 2: Delete duplicates + alerts for idle tails ──
    for (const [tail, alerts] of alertsByTail) {
      const isActive = activeSet.has(tail);

      if (!isActive) {
        // Idle tail — delete ALL alerts
        for (const alert of alerts) {
          try {
            await fetch(`${FA_BASE}/alerts/${alert.id}`, {
              method: "DELETE",
              headers: faHeaders(),
              signal: AbortSignal.timeout(10000),
            });
            console.log(`[FA Alerts] Deleted idle alert ${alert.id} for ${tail} (${alert.ident})`);
            await new Promise((resolve) => setTimeout(resolve, 300));
          } catch (err) {
            console.warn(`[FA Alerts] Delete error for ${tail}:`, err);
          }
        }
        // Mark inactive in DB
        await supa
          .from("fa_alert_registrations")
          .update({ active: false })
          .eq("tail", tail);
      } else if (alerts.length > 1) {
        // Active tail but has DUPLICATES — keep first, delete rest
        console.log(`[FA Alerts] ${tail} has ${alerts.length} duplicate alerts, cleaning up`);
        for (let i = 1; i < alerts.length; i++) {
          try {
            await fetch(`${FA_BASE}/alerts/${alerts[i].id}`, {
              method: "DELETE",
              headers: faHeaders(),
              signal: AbortSignal.timeout(10000),
            });
            console.log(`[FA Alerts] Deleted duplicate alert ${alerts[i].id} for ${tail}`);
            await new Promise((resolve) => setTimeout(resolve, 300));
          } catch (err) {
            console.warn(`[FA Alerts] Delete duplicate error for ${tail}:`, err);
          }
        }
        // Ensure DB has the kept alert
        await supa.from("fa_alert_registrations").upsert(
          { tail, alert_id: alerts[0].id, active: true },
          { onConflict: "tail" },
        );
      } else {
        // Active tail, single alert — sync to DB
        await supa.from("fa_alert_registrations").upsert(
          { tail, alert_id: alerts[0].id, active: true },
          { onConflict: "tail" },
        );
      }
    }

    // ── Step 3: Register alerts for active tails that have NONE on FA ──
    const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
    const webhookUrl = `${normalizedBase}/api/aircraft/webhook?secret=${encodeURIComponent(webhookSecret)}`;

    const missing = activeTails.filter((t) => !alertsByTail.has(t));

    if (missing.length === 0) {
      console.log(`[FA Alerts] All ${activeTails.length} active tails have alerts on FA`);
      return;
    }

    console.log(`[FA Alerts] Registering ${missing.length} new tails: ${missing.join(", ")}`);

    for (const tail of missing) {
      try {
        const ident = callsignMap?.get(tail) ?? tail;
        const res = await fetch(`${FA_BASE}/alerts`, {
          method: "POST",
          headers: faHeaders(),
          body: JSON.stringify({
            ident,
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

        if (res.ok) {
          // Parse alert ID from response body or Location header
          let alertId: number | null = null;
          const responseText = await res.text();
          if (responseText) {
            try {
              const data = JSON.parse(responseText);
              alertId = data.id ?? data.alert_id ?? null;
            } catch { /* empty response */ }
          }
          if (!alertId) {
            const location = res.headers.get("location");
            if (location) {
              const match = location.match(/\/alerts\/(\d+)/);
              if (match) alertId = parseInt(match[1], 10);
            }
          }

          // Always record in DB — use alert_id if we got one, otherwise use -1
          // so we know this tail is registered and don't re-register next cycle
          const { error: upsertErr } = await supa.from("fa_alert_registrations").upsert(
            { tail, alert_id: alertId ?? -1, active: true },
            { onConflict: "tail" },
          );
          if (upsertErr) {
            console.error(`[FA Alerts] DB upsert failed for ${tail}:`, upsertErr.message);
          }
          console.log(`[FA Alerts] Registered ${tail} as ${ident} (id: ${alertId ?? "unknown"})`);
        } else {
          const text = await res.text();
          console.warn(`[FA Alerts] Register failed for ${tail} (${ident}): ${res.status} ${text}`);
        }

        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        console.warn(`[FA Alerts] Register error for ${tail}:`, err);
      }
    }
  } catch (err) {
    console.warn("[FA Alerts] refreshAlerts error:", err);
  }
}
