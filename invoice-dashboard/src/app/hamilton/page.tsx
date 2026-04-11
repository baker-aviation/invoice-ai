export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import HamiltonClient from "./HamiltonClient";

export default async function HamiltonPage() {
  return (
    <>
      <Topbar title="Hamilton — Declined Trips" />
      <HamiltonClient />
    </>
  );
}
