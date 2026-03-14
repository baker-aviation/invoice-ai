export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFuelPrices, fetchAdvertisedPrices } from "@/lib/invoiceApi";
import FuelPricesTable from "./FuelPricesTable";

export default async function FuelPricesPage() {
  const [data, advertisedPrices] = await Promise.all([
    fetchFuelPrices({ limit: 2500 }),
    // Default: 4 weeks of advertised prices — covers all vendor cadences
    fetchAdvertisedPrices({ recentWeeks: 4 }).catch(() => []),
  ]);
  const fuelPrices = data.fuel_prices ?? [];

  return (
    <>
      <Topbar title="Fuel Prices" />
      <AutoRefresh intervalSeconds={120} />
      <FuelPricesTable initialPrices={fuelPrices} advertisedPrices={advertisedPrices} />
    </>
  );
}
