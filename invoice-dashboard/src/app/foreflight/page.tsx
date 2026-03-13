import { Topbar } from "@/components/Topbar";
import ForeFlightClient from "./ForeFlightClient";

export default function ForeFlightPage() {
  return (
    <>
      <Topbar title="ForeFlight" />
      <ForeFlightClient />
    </>
  );
}
