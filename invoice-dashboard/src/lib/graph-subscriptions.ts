import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Get an app-only Graph token */
export async function getGraphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("MS Graph credentials not configured");
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

const WEBHOOK_SECRET = () => process.env.GRAPH_WEBHOOK_SECRET || process.env.CRON_SECRET || "baker-graph-webhook";

type SubRecord = {
  graphId: string;
  expiresAt: string;
  mailbox: string;
};

const SETTINGS_KEY = "graph_mail_subscriptions";

/** Load subscription state from app_settings */
async function loadSubs(supa: ReturnType<typeof createServiceClient>): Promise<Record<string, SubRecord>> {
  const { data } = await supa
    .from("app_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();
  if (!data?.value) return {};
  try { return JSON.parse(data.value as string); } catch { return {}; }
}

/** Save subscription state to app_settings */
async function saveSubs(supa: ReturnType<typeof createServiceClient>, subs: Record<string, SubRecord>) {
  await supa
    .from("app_settings")
    .upsert({ key: SETTINGS_KEY, value: JSON.stringify(subs) }, { onConflict: "key" });
}

/**
 * Create or renew a Graph mail subscription for a mailbox.
 * Graph mail subscriptions expire after max 3 days (4230 minutes).
 */
export async function ensureSubscription(
  mailbox: string,
  handler: string,
): Promise<{ subscriptionId: string; expiresAt: string }> {
  const supa = createServiceClient();
  const token = await getGraphToken();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL not set — needed for webhook URL");

  const notificationUrl = `${appUrl}/api/webhooks/graph-mail`;
  const subs = await loadSubs(supa);
  const key = `${handler}@${mailbox}`;
  const existing = subs[key];

  // If we have a subscription that expires in more than 1 hour, try to extend it
  if (existing?.graphId) {
    const expiresAt = new Date(existing.expiresAt);
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

    if (expiresAt > oneHourFromNow) {
      const newExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000);
      const renewRes = await fetch(
        `${GRAPH_BASE}/subscriptions/${existing.graphId}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ expirationDateTime: newExpiry.toISOString() }),
        },
      );
      if (renewRes.ok) {
        const renewed = await renewRes.json();
        subs[key] = { graphId: existing.graphId, expiresAt: renewed.expirationDateTime, mailbox };
        await saveSubs(supa, subs);
        return { subscriptionId: existing.graphId, expiresAt: renewed.expirationDateTime };
      }
      console.warn(`[graph-sub] Renew failed for ${key}: ${renewRes.status}`);
    }
  }

  // Create new subscription
  const expirationDateTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000).toISOString();
  const resource = `users/${mailbox}/messages`;

  const createRes = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource,
      expirationDateTime,
      clientState: WEBHOOK_SECRET(),
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create subscription for ${key}: ${createRes.status} ${errText.slice(0, 300)}`);
  }

  const sub = await createRes.json();
  subs[key] = { graphId: sub.id, expiresAt: sub.expirationDateTime, mailbox };
  await saveSubs(supa, subs);

  return { subscriptionId: sub.id, expiresAt: sub.expirationDateTime };
}

/** Verify the clientState secret from a Graph notification */
export function verifyClientState(clientState: string | null | undefined): boolean {
  if (!clientState) return false;
  const expected = WEBHOOK_SECRET();
  if (clientState.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < clientState.length; i++) {
    result |= clientState.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}
