export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import ChiefPilotBoard from "./ChiefPilotBoard";

export default function ChiefPilotPage() {
  return (
    <>
      <Topbar title="Interview Review" />
      <ChiefPilotBoard />
    </>
  );
}
