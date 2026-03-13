export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import PilotsClient from "./PilotsClient";

export default function PilotsPage() {
  return (
    <>
      <Topbar title="Pilots" />
      <PilotsClient />
    </>
  );
}
