"use client";

import { Topbar } from "@/components/Topbar";
import UnifiedFuelEfficiency from "../UnifiedFuelEfficiency";

export default function FuelEfficiencyPage() {
  return (
    <>
      <Topbar title="Fuel Efficiency" />
      <UnifiedFuelEfficiency />
    </>
  );
}
