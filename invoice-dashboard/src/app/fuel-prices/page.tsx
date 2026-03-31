export const dynamic = "force-dynamic";
export const revalidate = 0;

import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFuelPrices, fetchAdvertisedPrices, fetchTripSalespersons } from "@/lib/invoiceApi";
import FuelPricesTable from "./FuelPricesTable";

export default async function FuelPricesPage() {
  // Fetch fuel prices and salespersons in parallel
  const [data, salespersons] = await Promise.all([
    fetchFuelPrices({ limit: 2500 }),
    fetchTripSalespersons().catch(() => []),
  ]);
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
