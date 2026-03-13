import { PilotShell } from "@/components/PilotShell";
import TimeOffClient from "./TimeOffClient";

export const dynamic = "force-dynamic";

export default function PilotTimeOffPage() {
  return (
    <PilotShell>
      <TimeOffClient />
    </PilotShell>
  );
}
