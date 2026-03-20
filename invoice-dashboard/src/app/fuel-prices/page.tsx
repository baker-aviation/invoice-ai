export const dynamic = "force-dynamic";
export const revalidate = 0;

import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFuelPrices, fetchAdvertisedPrices } from "@/lib/invoiceApi";
import FuelPricesTable from "./FuelPricesTable";

export default async function FuelPricesPage() {
  const [data, advertisedPrices] = await Promise.all([
    fetchFuelPrices({ limit: 2500 }),
    fetchAdvertisedPrices().catch(() => []),
  ]);
  const fuelPrices = data.fuel_prices ?? [];

  return (
    <>
      <AutoRefresh intervalSeconds={120} />
      <FuelPricesTable initialPrices={fuelPrices} advertisedPrices={advertisedPrices} />
    </>
  );
}
