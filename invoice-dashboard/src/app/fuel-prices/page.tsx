export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFuelPrices } from "@/lib/invoiceApi";
import FuelPricesTable from "./FuelPricesTable";

export default async function FuelPricesPage() {
  const data = await fetchFuelPrices({ limit: 300 });
  const fuelPrices = data.fuel_prices ?? [];

  return (
    <>
      <Topbar title="Fuel Prices" />
      <AutoRefresh intervalSeconds={120} />
      <FuelPricesTable initialPrices={fuelPrices} />
    </>
  );
}
