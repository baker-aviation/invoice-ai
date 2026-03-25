import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Get a random motivational quote from the database.
 * Returns a formatted string like:
 *   _"Quote text here."_ — Author
 *
 * Returns null if no quotes exist.
 */
export async function getRandomQuote(): Promise<string | null> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("motivational_quotes")
    .select("quote, author");

  if (error || !data || data.length === 0) return null;

  const pick = data[Math.floor(Math.random() * data.length)];
  const attribution = pick.author ? ` — ${pick.author}` : "";
  return `_"${pick.quote}"_${attribution}`;
}
