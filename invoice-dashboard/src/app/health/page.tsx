export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { HealthBoard } from "./HealthBoard";

export default function HealthPage() {
  return (
    <>
      <Topbar title="System Health" />
      <HealthBoard />
    </>
  );
}
