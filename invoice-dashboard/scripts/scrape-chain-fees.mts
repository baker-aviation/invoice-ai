/**
 * Scrape FBO chain websites for fee data per aircraft type.
 * - Atlantic: public /umbraco/api/ endpoints (fees + locations)
 * - Signature: Strapi API (emails, contact) + attempt pricing API
 *
 * Usage: node --experimental-strip-types scripts/scrape-chain-fees.mts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const AIRCRAFT = [
  { label: "Citation X", atlanticId: "51", sigModel: "Cessna Aircraft Company 750 Citation" },
  { label: "Challenger 300", atlanticId: "741", sigModel: "Bombardier CL-300" },
];

// ---------------------------------------------------------------------------
// Atlantic Aviation — public Umbraco API
// ---------------------------------------------------------------------------

async function scrapeAtlantic() {
  console.log("\n=== ATLANTIC AVIATION ===");

  // 1. Get all locations
  const locRes = await fetch("https://www.atlanticaviation.com/umbraco/api/Locations/Index", {
    headers: { "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const locations: Array<{
    airportCode: string; city: string; state: string; phone: string;
    hoursOfOperation: string; latitude: number; longitude: number;
  }> = await locRes.json();
  console.log(`${locations.length} Atlantic locations found`);

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    const code = loc.airportCode;

    // Strip HTML from hours
    const hours = loc.hoursOfOperation
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .trim();
    const is24hr = /24\s*hour/i.test(hours);

    for (const ac of AIRCRAFT) {
      try {
        await sleep(DELAY_MS);
        const feeRes = await fetch(
          `https://www.atlanticaviation.com/umbraco/api/FacilityLookup/Get?aiportCode=${code}&makeModelid=${ac.atlanticId}&arrivalDate=2026-04-11`,
          {
            headers: { "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0" },
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (!feeRes.ok) {
          process.stdout.write("x");
          continue;
        }

        const fees = await feeRes.json();

        const record = {
          airport_code: code,
          icao: code.length === 3 ? `K${code}` : code,
          fbo_name: `Atlantic Aviation ${code}`,
          chain: "Atlantic Aviation",
          aircraft_type: ac.label,
          facility_fee: fees.facilityFee?.unitPrice ?? null,
          handling_fee: null as number | null,
          gallons_to_waive: fees.gallonsToWaive?.unitPrice ?? null,
          security_fee: fees.securityFee?.unitPrice ?? null,
          infrastructure_fee: null as number | null,
          landing_fee: null as number | null,
          overnight_fee: null as number | null,
          parking_info: fees.hourlyParkingMessage || "",
          hangar_fee: null as number | null,
          hangar_info: fees.hourlyHangarMessage || "",
          gpu_fee: null as number | null,
          lavatory_fee: null as number | null,
          water_fee: null as number | null,
          jet_a_price: null as number | null,
          phone: loc.phone || "",
          email: "",
          city: loc.city || "",
          state: loc.state || "",
          country: "United States",
          updated_at: new Date().toISOString(),
        };

        // Parse special event / habitat fees
        if (fees.habitatFee?.unitPrice) {
          record.infrastructure_fee = fees.habitatFee.unitPrice;
        }

        await supa.from("fbo_website_fees").upsert(record, {
          onConflict: "airport_code,fbo_name,aircraft_type",
        });

        // Also update fbo_handling_fees email/phone if missing
        if (loc.phone) {
          await supa
            .from("fbo_handling_fees")
            .update({ phone: loc.phone })
            .ilike("fbo_name", "%atlantic%")
            .eq("airport_code", code)
            .eq("aircraft_type", ac.label)
            .or("phone.is.null,phone.eq.");
        }

        updated++;
        process.stdout.write(fees.facilityFee ? "✓" : ".");
      } catch (err) {
        errors++;
        process.stdout.write("!");
      }
    }

    if ((i + 1) % 20 === 0) {
      console.log(`\n  [${i + 1}/${locations.length}] Updated: ${updated}, Errors: ${errors}`);
    }
  }

  console.log(`\n  Atlantic done: ${updated} records updated, ${errors} errors`);
  return updated;
}

// ---------------------------------------------------------------------------
// Signature Aviation — Strapi API for contact + email
// ---------------------------------------------------------------------------

async function scrapeSignature() {
  console.log("\n=== SIGNATURE AVIATION ===");

  // Get all FBOs from Strapi (paginated)
  const allFbos: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://www.signatureaviation.com/api/strapi/fbos?populate=*&pagination%5BpageSize%5D=100&pagination%5Bpage%5D=${page}`,
      {
        headers: { "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const data = await res.json();
    if (!data.data?.length) break;
    allFbos.push(...data.data);
  }
  console.log(`${allFbos.length} Signature FBOs from Strapi`);

  // Filter to US locations
  const usFbos = allFbos.filter((f) => f.country === "United States");
  console.log(`${usFbos.length} US locations`);

  let updated = 0;
  let emailsAdded = 0;

  for (let i = 0; i < usFbos.length; i++) {
    const fbo = usFbos[i];
    const iata = String(fbo.iata || "");
    const email = String(fbo.email || "");
    const phone = String(fbo.phone || "");
    const fboName = String(fbo.name || `SIGNATURE ${iata}`);
    const city = String(fbo.city || "");
    const state = String(fbo.state || "");
    const hours = String(fbo.hoursOfOperation || "");
    const baseId = String(fbo.baseId || "");
    const baseCode = String(fbo.baseCode || "");

    if (!iata) continue;

    // Upsert to fbo_website_fees for each aircraft type
    for (const ac of AIRCRAFT) {
      const record = {
        airport_code: iata,
        icao: iata.length === 3 ? `K${iata}` : iata,
        fbo_name: fboName,
        chain: "Signature Flight Support",
        aircraft_type: ac.label,
        phone,
        email,
        city,
        state,
        country: "United States",
        updated_at: new Date().toISOString(),
      };

      await supa.from("fbo_website_fees").upsert(record, {
        onConflict: "airport_code,fbo_name,aircraft_type",
      });
      updated++;
    }

    // Update fbo_handling_fees with email if missing
    if (email) {
      const { data: existing } = await supa
        .from("fbo_handling_fees")
        .select("id, email")
        .eq("airport_code", iata)
        .ilike("fbo_name", "%signature%")
        .or("email.is.null,email.eq.");

      if (existing?.length) {
        await supa
          .from("fbo_handling_fees")
          .update({ email })
          .eq("airport_code", iata)
          .ilike("fbo_name", "%signature%")
          .or("email.is.null,email.eq.");
        emailsAdded += existing.length;
      }
    }

    process.stdout.write(email ? "✓" : ".");

    if ((i + 1) % 30 === 0) {
      console.log(`\n  [${i + 1}/${usFbos.length}] Updated: ${updated}, Emails backfilled: ${emailsAdded}`);
    }
  }

  // Try pricing API for each US FBO
  console.log(`\n  Now attempting fee scrape via pricing API...`);
  let feesFetched = 0;

  for (const fbo of usFbos) {
    const iata = String(fbo.iata || "");
    const baseId = String(fbo.baseId || "");
    const baseCode = String(fbo.baseCode || "");
    const fboName = String(fbo.name || `SIGNATURE ${iata}`);
    if (!baseId || !baseCode) continue;

    for (const ac of AIRCRAFT) {
      try {
        await sleep(DELAY_MS);
        // Try the pricing API — may need auth
        const res = await fetch(
          `https://www.signatureaviation.com/api/rest/pricing/services?baseId=${baseId}&baseCode=${baseCode}&pricingDate=2026-04-08&aircraftModelName=${encodeURIComponent(ac.sigModel)}`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (!res.ok) {
          if (feesFetched === 0 && ac === AIRCRAFT[0]) {
            // First attempt failed — pricing API needs auth, skip all
            console.log(`\n  Pricing API returned ${res.status} — needs auth, skipping fee scrape`);
            // Still try fuel prices
            break;
          }
          continue;
        }

        const data = await res.json();
        if (data.data) {
          // Update fbo_website_fees with fee data
          const fees = data.data;
          const update: Record<string, unknown> = {};
          for (const item of fees) {
            const name = String(item.name || "").toLowerCase();
            const price = item.price ?? item.unitPrice;
            if (name.includes("handling")) update.handling_fee = price;
            else if (name.includes("infrastructure")) update.infrastructure_fee = price;
            else if (name.includes("gpu") && !name.includes("start")) update.gpu_fee = price;
            else if (name.includes("hangar")) update.hangar_fee = price;
            else if (name.includes("lavatory")) update.lavatory_fee = price;
            else if (name.includes("water")) update.water_fee = price;
            else if (name.includes("security")) update.security_fee = price;
          }

          // Gallons to waive from the handling fee description
          const handlingItem = fees.find((f: Record<string, unknown>) => String(f.name || "").toLowerCase().includes("handling"));
          if (handlingItem?.description) {
            const galMatch = String(handlingItem.description).match(/(\d+)\s*US\s*Gallon/i);
            if (galMatch) update.gallons_to_waive = parseInt(galMatch[1]);
          }

          if (Object.keys(update).length > 0) {
            update.updated_at = new Date().toISOString();
            await supa
              .from("fbo_website_fees")
              .update(update)
              .eq("airport_code", iata)
              .eq("fbo_name", fboName)
              .eq("aircraft_type", ac.label);
            feesFetched++;
            process.stdout.write("$");
          }
        }
      } catch {
        // Skip on error
      }
    }

    // Break out if pricing API doesn't work (first FBO attempt will tell us)
    if (feesFetched === 0) break;
  }

  // Try fuel prices
  console.log(`\n  Attempting fuel prices...`);
  let fuelFetched = 0;

  for (const fbo of usFbos.slice(0, 3)) {
    const baseId = String(fbo.baseId || "");
    const baseCode = String(fbo.baseCode || "");
    if (!baseId || !baseCode) continue;

    try {
      const res = await fetch(
        `https://www.signatureaviation.com/api/rest/pricing/fuel?baseId=${baseId}&baseCode=${baseCode}&pricingDate=2026-04-08`,
        {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        console.log(`  Fuel sample (${fbo.iata}):`, JSON.stringify(data).slice(0, 300));
        fuelFetched++;
      } else {
        console.log(`  Fuel API: ${res.status} — needs auth`);
        break;
      }
    } catch {
      break;
    }
  }

  console.log(`\n  Signature done: ${updated} website_fees records, ${emailsAdded} emails backfilled to handling_fees, ${feesFetched} with fee data`);
  return emailsAdded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const atlanticUpdated = await scrapeAtlantic();
  const sigEmails = await scrapeSignature();

  // Final stats
  const { count: withEmail } = await supa
    .from("fbo_handling_fees")
    .select("*", { count: "exact", head: true })
    .neq("email", "")
    .not("email", "is", null);
  const { count: total } = await supa
    .from("fbo_handling_fees")
    .select("*", { count: "exact", head: true });
  const { count: websiteTotal } = await supa
    .from("fbo_website_fees")
    .select("*", { count: "exact", head: true });
  const { count: websiteWithFees } = await supa
    .from("fbo_website_fees")
    .select("*", { count: "exact", head: true })
    .not("facility_fee", "is", null);

  console.log(`\n=== FINAL STATS ===`);
  console.log(`fbo_handling_fees: ${total} total, ${withEmail} with email (${((withEmail! / total!) * 100).toFixed(1)}%)`);
  console.log(`fbo_website_fees: ${websiteTotal} total, ${websiteWithFees} with fee data`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
