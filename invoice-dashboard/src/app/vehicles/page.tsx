export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import VehiclesClient from "./VehiclesClient";

export default function VehiclesPage() {
  return (
    <>
      <Topbar title="Vehicles" />
      <AutoRefresh intervalSeconds={240} />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          Fleet tracking via Samsara · preventive maintenance calendar
        </p>
        <VehiclesClient />
      </div>
    </>
  );
}
