/**
 * Scrape AirNav.com for FBO emails, phones, and fuel prices.
 * AirNav has contact info for nearly every US FBO.
 *
 * Usage: node --experimental-strip-types scripts/scrape-airnav-emails.mts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const DELAY_MS = 2500; // Be respectful to AirNav
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface AirnavFbo {
  name: string;
  email: string;
  phone: string;
  fuelPrices: { type: string; price: number }[];
}

function parseAirnavPage(html: string): AirnavFbo[] {
  const fbos: AirnavFbo[] = [];

  // Find FBO section: starts after <A name="biz">
  const bizIdx = html.indexOf('<A name="biz">');
  if (bizIdx === -1) return fbos;

  // Each FBO row has a mailto: link and business name in an IMG alt or text
  // Pattern: <A href="/airport/XXXX/FBO_ID"><IMG ... alt="FBO Name" ...>
  // Then:    <A href="mailto:email@domain.com?subject=...">email</A>
  // Then:    phone number as plain text

  const section = html.slice(bizIdx);

  // Split by FBO rows - each starts with a link to /airport/CODE/FBO_ID
  const fboPattern = /<TD width=240>.*?<IMG[^>]*alt="([^"]*)"[^>]*>.*?<\/TD>\s*<TD><\/TD>\s*<TD[^>]*>(.*?)<\/TD>/gs;

  let match;
  while ((match = fboPattern.exec(section)) !== null) {
    const name = match[1].trim();
    const contactCell = match[2];

    // Extract email from mailto: link
    const emailMatch = contactCell.match(/mailto:([^?"]+)/);
    const email = emailMatch ? emailMatch[1].trim() : "";

    // Extract phone - first number pattern after <BR>
    const phoneMatch = contactCell.match(/<BR>(\d{3}[-.]?\d{3}[-.]?\d{4})/);
    const phone = phoneMatch ? phoneMatch[1] : "";

    fbos.push({ name, email, phone, fuelPrices: [] });
  }

  // Also try a simpler regex approach for emails we might have missed
  if (fbos.length === 0) {
    const emailPattern = /mailto:([^?"]+)\?subject=Message from AirNav\.com user to ([^(]+)\(/g;
    let em;
    while ((em = emailPattern.exec(section)) !== null) {
      const email = em[1].trim();
      const name = em[2].trim();
      // Check if already found
      if (!fbos.find((f) => f.email === email)) {
        fbos.push({ name, email, phone: "", fuelPrices: [] });
      }
    }
  }

  return fbos;
}

function faaToIcao(faa: string): string {
  const code = faa.toUpperCase().trim();
  if (code.length === 4) return code;
  if (code.length === 3) return `K${code}`;
  return code;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  // Get all FBOs missing email
  const { data: missing } = await supa
    .from("fbo_handling_fees")
    .select("airport_code, fbo_name, aircraft_type")
    .or("email.is.null,email.eq.");

  // Group by airport
  const airportMap = new Map<string, Array<{ fbo_name: string; aircraft_type: string }>>();
  for (const r of missing || []) {
    if (!airportMap.has(r.airport_code)) airportMap.set(r.airport_code, []);
    airportMap.get(r.airport_code)!.push({ fbo_name: r.fbo_name, aircraft_type: r.aircraft_type });
  }

  const airports = [...airportMap.keys()].sort();
  console.log(`${airports.length} airports with FBOs missing email`);
  console.log(`${missing?.length} total FBO records to try`);

  let emailsFound = 0;
  let emailsUpdated = 0;
  let errors = 0;
  let noFboSection = 0;

  for (let i = 0; i < airports.length; i++) {
    const code = airports[i];
    const icao = faaToIcao(code);

    try {
      const res = await fetch(`https://www.airnav.com/airport/${icao}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });

      if (!res.ok) {
        process.stdout.write("x");
        await sleep(DELAY_MS);
        continue;
      }

      const html = await res.text();
      const airnavFbos = parseAirnavPage(html);

      if (airnavFbos.length === 0) {
        // Try with just the FAA code
        if (icao !== code) {
          const res2 = await fetch(`https://www.airnav.com/airport/${code}`, {
            headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
            signal: AbortSignal.timeout(15_000),
            redirect: "follow",
          });
          if (res2.ok) {
            const html2 = await res2.text();
            const fbos2 = parseAirnavPage(html2);
            airnavFbos.push(...fbos2);
          }
        }

        if (airnavFbos.length === 0) {
          noFboSection++;
          process.stdout.write("-");
          await sleep(DELAY_MS);
          continue;
        }
      }

      // Match AirNav FBOs to our DB records
      const ourFbos = airportMap.get(code) || [];
      let matchedAny = false;

      for (const airnavFbo of airnavFbos) {
        if (!airnavFbo.email) continue;
        emailsFound++;

        const anName = normalizeName(airnavFbo.name);

        // Try to match by name similarity
        for (const ourFbo of ourFbos) {
          const ourName = normalizeName(ourFbo.fbo_name);

          // Check various match strategies
          const isMatch =
            anName === ourName ||
            anName.includes(ourName) ||
            ourName.includes(anName) ||
            // Match on key words (e.g. "Atlantic Aviation" matches "Atlantic Aviation TEB")
            (anName.split(" ").length >= 2 &&
              anName.split(" ").slice(0, 2).join(" ") === ourName.split(" ").slice(0, 2).join(" ")) ||
            // Match chain names
            (anName.includes("signature") && ourName.includes("signature")) ||
            (anName.includes("atlantic") && ourName.includes("atlantic")) ||
            (anName.includes("million air") && ourName.includes("million air")) ||
            (anName.includes("sheltair") && ourName.includes("sheltair")) ||
            (anName.includes("jet aviation") && ourName.includes("jet aviation")) ||
            (anName.includes("modern aviation") && ourName.includes("modern aviation")) ||
            (anName.includes("cutter") && ourName.includes("cutter"));

          if (isMatch) {
            const { error } = await supa
              .from("fbo_handling_fees")
              .update({ email: airnavFbo.email })
              .eq("airport_code", code)
              .eq("fbo_name", ourFbo.fbo_name)
              .eq("aircraft_type", ourFbo.aircraft_type)
              .or("email.is.null,email.eq.");

            if (!error) {
              emailsUpdated++;
              matchedAny = true;
            }
          }
        }

        // If no exact match, try to update any FBO at this airport with same chain
        if (!matchedAny) {
          // For single-FBO airports, just update whatever's there
          if (ourFbos.length <= 2 && airnavFbos.length === 1) {
            for (const ourFbo of ourFbos) {
              await supa
                .from("fbo_handling_fees")
                .update({ email: airnavFbo.email })
                .eq("airport_code", code)
                .eq("fbo_name", ourFbo.fbo_name)
                .eq("aircraft_type", ourFbo.aircraft_type)
                .or("email.is.null,email.eq.");
              emailsUpdated++;
              matchedAny = true;
            }
          }
        }
      }

      process.stdout.write(matchedAny ? "✓" : ".");
    } catch (err) {
      errors++;
      process.stdout.write("!");
    }

    await sleep(DELAY_MS);

    if ((i + 1) % 20 === 0) {
      console.log(`\n  [${i + 1}/${airports.length}] Emails found: ${emailsFound}, Updated: ${emailsUpdated}, No FBO section: ${noFboSection}, Errors: ${errors}`);
    }
  }

  console.log(`\n\nDone!`);
  console.log(`  AirNav emails found: ${emailsFound}`);
  console.log(`  DB records updated: ${emailsUpdated}`);
  console.log(`  Airports with no FBO section: ${noFboSection}`);
  console.log(`  Errors: ${errors}`);

  // Final stats
  const { count: withEmail } = await supa
    .from("fbo_handling_fees")
    .select("*", { count: "exact", head: true })
    .neq("email", "")
    .not("email", "is", null);
  const { count: total } = await supa
    .from("fbo_handling_fees")
    .select("*", { count: "exact", head: true });
  console.log(`\nFinal: ${total} total, ${withEmail} with email (${((withEmail! / total!) * 100).toFixed(1)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
