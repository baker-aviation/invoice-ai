export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import CrewCarsClient from "./CrewCarsClient";

export default function CrewCarsPage() {
  return (
    <>
      <Topbar title="Pilot Crew Cars" />
      <AutoRefresh intervalSeconds={240} />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          Live crew car locations via Samsara · oil change tracker
        </p>
        <CrewCarsClient />
      </div>
    </>
  );
}
