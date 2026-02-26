export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { fetchAlerts } from "@/lib/invoiceApi";
import AlertsTable from "./AlertsTable";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function AlertsPage() {
  const data = await fetchAlerts({ limit: 200 });
  const alerts = data.alerts ?? [];

  return (
    <>
      <Topbar title="Alerts" />
      <AutoRefresh intervalSeconds={120} />
      <AlertsTable initialAlerts={alerts} />
    </>
  );
}