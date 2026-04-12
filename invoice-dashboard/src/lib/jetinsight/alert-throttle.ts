import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

const THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns true if we should send a session-expired alert.
 * Suppresses if:
 *  - Cookie was updated in the last hour (user just refreshed it)
 *  - An alert was already sent in the last hour
 */
export async function shouldAlertJetInsightExpiry(): Promise<boolean> {
  const supa = createServiceClient();

  // If the cookie was refreshed recently, don't nag
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("updated_at")
    .eq("config_key", "session_cookie")
    .single();
  if (cookieRow?.updated_at) {
    const age = Date.now() - new Date(cookieRow.updated_at).getTime();
    if (age < THROTTLE_MS) return false;
  }

  // Throttle: only one alert per hour across all crons
  const { data } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "expiry_alerted_at")
    .single();
  if (data?.config_value) {
    const last = new Date(data.config_value).getTime();
    if (Date.now() - last < THROTTLE_MS) return false;
  }

  // Mark as alerted
  await supa.from("jetinsight_config").upsert(
    {
      config_key: "expiry_alerted_at",
      config_value: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "config_key" },
  );

  return true;
}
