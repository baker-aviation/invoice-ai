import { createServiceClient } from "@/lib/supabase/service";

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
    // If table doesn't exist or query fails, default to enabled
    return true;
  }
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
