export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchAlerts } from "@/lib/invoiceApi";
import AlertsTable from "./AlertsTable";

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
