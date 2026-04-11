import { createServiceClient } from "@/lib/supabase/service";

export const FUEL_PLANNING_TEST_CHANNEL = "C0ANTTQ6R96"; // #fuel-planning

/**
 * Check if Slack messaging is enabled (kill switch).
 * Returns false if the super admin has disabled Slack via app_settings.
 */
export async function isSlackEnabled(): Promise<boolean> {
  try {
    const supa = createServiceClient();
    const { data } = await supa
      .from("app_settings")
      .select("value")
      .eq("key", "slack_enabled")
      .single();
    return data?.value !== "false";
  } catch {
    return true;
  }
}

/**
 * When fuel_slack_test_mode is on, all fuel-related Slack messages are
 * redirected to #fuel-planning regardless of the intended channel.
 * Unrelated Slack traffic (vans, crew swap, hiring, etc.) is untouched.
 */
export async function isFuelSlackTestMode(): Promise<boolean> {
  try {
    const supa = createServiceClient();
    const { data } = await supa
      .from("app_settings")
      .select("value")
      .eq("key", "fuel_slack_test_mode")
      .single();
    return data?.value === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve the channel a fuel-related Slack message should land in.
 * Pass the intended channel (e.g. a per-tail channel); we override to the
 * test channel if fuel_slack_test_mode is on.
 */
export async function resolveFuelSlackChannel(intended: string | null | undefined): Promise<string> {
  if (await isFuelSlackTestMode()) return FUEL_PLANNING_TEST_CHANNEL;
  return intended || FUEL_PLANNING_TEST_CHANNEL;
}

/**
 * Post a message to Slack, respecting the kill switch.
 * Returns the Slack API response, or null if Slack is disabled.
 */
export async function postSlackMessage(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;

  const enabled = await isSlackEnabled();
  if (!enabled) {
    console.log("[slack] Kill switch active — message suppressed to", payload.channel);
    return null;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
