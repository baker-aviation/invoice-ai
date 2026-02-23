import { Topbar } from "@/components/Topbar";
import { fetchAlerts } from "@/lib/invoiceApi";
import AlertsTable from "./AlertsTable";

export default async function AlertsPage() {
  const data = await fetchAlerts({ limit: 200 });
  const alerts = data.alerts ?? [];

  return (
    <>
      <Topbar title="Alerts" />
      <AlertsTable initialAlerts={alerts} />
    </>
  );
}