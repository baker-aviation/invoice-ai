export const dynamic = "force-dynamic";

import { PilotShell } from "@/components/PilotShell";
import ScheduleClient from "./ScheduleClient";

export default function PilotSchedulePage() {
  return (
    <PilotShell>
      <ScheduleClient />
    </PilotShell>
  );
}
