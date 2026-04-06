import { AppShell } from "@/components/AppShell";
import FleetFuelDashboard from "./FleetFuelDashboard";

export const metadata = { title: "Fuel Releases — Baker Aviation" };

export default function FuelDashboardPage() {
  return (
    <AppShell>
      <FleetFuelDashboard />
    </AppShell>
  );
}
