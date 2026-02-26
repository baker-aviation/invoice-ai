import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import AlertsTable from "./AlertsTable";

export default function AlertsPage() {
  return (
    <>
      <Topbar title="Alerts" />
      <AutoRefresh intervalSeconds={120} />
      <AlertsTable />
    </>
  );
}
