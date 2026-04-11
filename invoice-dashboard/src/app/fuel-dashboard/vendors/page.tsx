import { AppShell } from "@/components/AppShell";
import FuelVendorsAdmin from "./FuelVendorsAdmin";

export const metadata = { title: "Fuel Vendors — Baker Aviation" };

export default function FuelVendorsPage() {
  return (
    <AppShell>
      <FuelVendorsAdmin />
    </AppShell>
  );
}
