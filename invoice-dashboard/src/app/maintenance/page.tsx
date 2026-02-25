import { Topbar } from "@/components/Topbar";
import VanPositioningClient from "./VanPositioningClient";

export default function MaintenancePage() {
  return (
    <>
      <Topbar title="Maintenance Positioning" />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          Overnight aircraft positions derived from JetInsight trips · 16 maintenance vans · simulation
        </p>
        <VanPositioningClient />
      </div>
    </>
  );
}
