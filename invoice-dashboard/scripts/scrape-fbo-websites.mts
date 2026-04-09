/**
 * Scrape FBO chain websites for contact info (email, phone, hours).
 * Chains: Atlantic Aviation, Million Air, Sheltair
 *
 * Usage: node --experimental-strip-types scripts/scrape-fbo-websites.mts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ---------------------------------------------------------------------------
// Chain configs
// ---------------------------------------------------------------------------

type ChainConfig = {
  name: string;
  namePattern: string; // ilike pattern for fbo_handling_fees
  urlTemplate: (code: string) => string;
  parseEmail: (html: string, code: string) => string;
  parsePhone: (html: string) => string;
  parseHours: (html: string) => string;
  parseAddress: (html: string) => { city: string; state: string };
};

const CHAINS: ChainConfig[] = [
  {
    name: "Atlantic Aviation",
    namePattern: "%atlantic%",
    urlTemplate: (code) => `https://www.atlanticaviation.com/location/${code}`,
    parseEmail: (html) => {
      // Atlantic uses contact forms, no emails on pages
      const m = html.match(/[\w.+-]+@atlanticaviation\.com/i);
      return m ? m[0] : "";
    },
    parsePhone: (html) => {
      const m = html.match(/\(\d{3}\)\s*\d{3}[-.\s]\d{4}/);
      return m ? m[0] : "";
    },
    parseHours: (html) => {
      const m = html.match(/Mon[^<]{3,60}(?:24\s*Hours|\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      return m ? m[0].trim() : "";
    },
    parseAddress: (html) => {
      const m = html.match(/(\d+[^<,]{5,40}),\s*([A-Za-z\s]+),\s*([A-Z]{2})\s+(\d{5})/);
      return { city: m ? m[2].trim() : "", state: m ? m[3] : "" };
    },
  },
  {
    name: "Million Air",
    namePattern: "%million air%",
    urlTemplate: (code) => `https://www.millionair.com/locations/${code.toLowerCase()}/`,
    parseEmail: (html, code) => {
      // Pattern: info.{code}@millionair.com
      const m = html.match(/info[.\-][\w.]+@millionair\.com/i);
      return m ? m[0].toLowerCase() : "";
    },
    parsePhone: (html) => {
      // First phone on page is usually the main FBO number
      const m = html.match(/[\(]?\d{3}[\).\-\s]+\d{3}[\-.\s]+\d{4}/);
      return m ? m[0] : "";
    },
    parseHours: (html) => {
      const m = html.match(/(?:24[\/\s]*7|open\s*24|24\s*hours)/i);
      return m ? "24 Hours" : "";
    },
    parseAddress: (html) => {
      const m = html.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z]{2})\s+(\d{5})/);
      return { city: m ? m[1].trim() : "", state: m ? m[2] : "" };
    },
  },
  {
    name: "Sheltair",
    namePattern: "%sheltair%",
    urlTemplate: (code) => `https://www.sheltairaviation.com/locations/${code.toLowerCase()}/`,
    parseEmail: (html, code) => {
      // Pattern: info-{code}@sheltairaviation.com
      const m = html.match(/info[\-.][\w.-]+@sheltairaviation\.com/i);
      return m ? m[0].toLowerCase() : "";
    },
    parsePhone: (html) => {
      const m = html.match(/[\(]?\d{3}[\).\-\s]+\d{3}[\-.\s]+\d{4}/);
      return m ? m[0] : "";
    },
    parseHours: (html) => {
      const m = html.match(/(?:24[\/\s]*7|open\s*24|24\s*hours)/i);
      return m ? "24 Hours" : "";
    },
    parseAddress: (html) => {
      const m = html.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z]{2})\s+(\d{5})/);
      return { city: m ? m[1].trim() : "", state: m ? m[2] : "" };
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let grandTotal = 0;
  let grandEmails = 0;

  for (const chain of CHAINS) {
    console.log(`\n=== ${chain.name} ===`);

    // Get airports with this chain missing email
    const { data } = await supa
      .from("fbo_handling_fees")
      .select("airport_code, fbo_name")
      .or("email.is.null,email.eq.")
      .ilike("fbo_name", chain.namePattern)
      .order("airport_code");

    const airports = [...new Set(data?.map((r) => r.airport_code))].sort();
    console.log(`${airports.length} airports to scrape`);

    let found = 0;
    let emails = 0;
    let errors = 0;

    for (let i = 0; i < airports.length; i++) {
      const code = airports[i];
      try {
        const url = chain.urlTemplate(code);
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html" },
          signal: AbortSignal.timeout(15_000),
          redirect: "follow",
        });

        if (!res.ok) {
          process.stdout.write("x");
          await sleep(DELAY_MS);
          continue;
        }

        const html = await res.text();
        const email = chain.parseEmail(html, code);
        const phone = chain.parsePhone(html);
        const hours = chain.parseHours(html);
        const { city, state } = chain.parseAddress(html);
        const is24hr = /24\s*hour|24\/7|open\s*24/i.test(hours || html);

        if (!email && !phone && !hours) {
          process.stdout.write("-");
          await sleep(DELAY_MS);
          continue;
        }

        found++;
        if (email) emails++;

        // Get the actual FBO names for this airport+chain to match records
        const matchingFbos = data?.filter((r) => r.airport_code === code) || [];
        const fboNames = [...new Set(matchingFbos.map((r) => r.fbo_name))];

        for (const fboName of fboNames) {
          // Upsert to fbo_website_fees
          for (const acType of ["Citation X", "Challenger 300"]) {
            await supa.from("fbo_website_fees").upsert(
              {
                airport_code: code,
                icao: code.length === 3 ? `K${code}` : code,
                fbo_name: fboName,
                chain: chain.name,
                aircraft_type: acType,
                phone,
                email,
                city,
                state,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "airport_code,fbo_name,aircraft_type" },
            );
          }

          // Update fbo_handling_fees with email if we got one and it's missing
          if (email) {
            await supa
              .from("fbo_handling_fees")
              .update({ email })
              .eq("airport_code", code)
              .eq("fbo_name", fboName)
              .or("email.is.null,email.eq.");
          }
        }

        process.stdout.write(email ? "✓" : ".");
      } catch (err) {
        process.stdout.write("!");
        errors++;
      }

      await sleep(DELAY_MS);

      if ((i + 1) % 20 === 0) {
        console.log(`\n  [${i + 1}/${airports.length}] Found: ${found}, Emails: ${emails}, Errors: ${errors}`);
      }
    }

    console.log(`\n  ${chain.name} done: ${found} locations, ${emails} emails, ${errors} errors`);
    grandTotal += found;
    grandEmails += emails;
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Total locations scraped: ${grandTotal}, Emails found: ${grandEmails}`);

  // Final stats
  const { count: withEmail } = await supa
    .from("fbo_handling_fees")
    .select("*", { count: "exact", head: true })
    .neq("email", "")
    .not("email", "is", null);
  const { count: total } = await supa
    .from("fbo_handling_fees")
    .select("*", { count: "exact", head: true });
  console.log(`Overall: ${total} total FBOs, ${withEmail} with email (${((withEmail! / total!) * 100).toFixed(1)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
