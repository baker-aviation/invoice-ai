export const dynamic = 'force-dynamic';

import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFuelPrices, fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { fetchFlightsLite } from "@/lib/opsApi";
import FuelPricesTable from "./FuelPricesTable";

export default async function FuelPricesPage() {
  // Fetch fuel prices and flights (for salesperson lookup) in parallel
  const [data, flightData] = await Promise.all([
    fetchFuelPrices({ limit: 2500 }),
    fetchFlightsLite({ lookahead_hours: 720, lookback_hours: 720 }).catch(() => ({ flights: [] })),
  ]);

  // Build salesperson entries from flights data (populated by JetInsight scraper)
  const toIata = (icao: string | null) =>
    icao && icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
  const salespersons: { tail_number: string; airport_iata: string; date: string; salesperson: string }[] = [];
  for (const f of flightData.flights) {
    if (!f.tail_number || !f.salesperson || !f.scheduled_departure) continue;
    const date = f.scheduled_departure.split("T")[0];
    const origIata = toIata(f.departure_icao);
    const destIata = toIata(f.arrival_icao);
    if (origIata) salespersons.push({ tail_number: f.tail_number, airport_iata: origIata, date, salesperson: f.salesperson });
    if (destIata) salespersons.push({ tail_number: f.tail_number, airport_iata: destIata, date, salesperson: f.salesperson });
  }
  const fuelPrices = data.fuel_prices ?? [];

  // Compute how many weeks of advertised prices we need to cover all invoices
  let recentWeeks = 2;
  if (fuelPrices.length > 0) {
    const oldest = fuelPrices.reduce(
      (min: string, p: { invoice_date?: string | null }) =>
        p.invoice_date && p.invoice_date < min ? p.invoice_date : min,
      new Date().toISOString().split("T")[0],
    );
    recentWeeks = Math.ceil((Date.now() - new Date(oldest).getTime()) / (7 * 86_400_000)) + 1;
  }
  const advertisedPrices = await fetchAdvertisedPrices({ recentWeeks }).catch(() => []);

  return (
    <>
      <AutoRefresh intervalSeconds={120} />
      <FuelPricesTable initialPrices={fuelPrices} advertisedPrices={advertisedPrices} salespersons={salespersons} />
    </>
  );
}
