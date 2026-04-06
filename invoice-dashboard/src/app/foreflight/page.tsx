"use client";

import { Topbar } from "@/components/Topbar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ForeFlightClient from "./ForeFlightClient";
import TankeringDashboard from "./TankeringDashboard";
import DispatchFlights from "./DispatchFlights";
import CreateFlight from "./CreateFlight";
import WebhookEvents from "./WebhookEvents";
import UnifiedFuelEfficiency from "./UnifiedFuelEfficiency";
import FuelChoiceReview from "./FuelChoiceReview";
import FleetFuelDashboard from "@/app/fuel-dashboard/FleetFuelDashboard";

export default function FuelPlanningPage() {
  return (
    <>
      <Topbar title="Fuel Planning" />

      <Tabs defaultValue="tankering" className="px-6 -mt-2">
        <TabsList variant="line" className="mb-4 overflow-x-auto">
          <TabsTrigger value="fbo">FBO Fuel Check</TabsTrigger>
          <TabsTrigger value="tankering">Tankering Plans</TabsTrigger>
          <TabsTrigger value="releases">Fuel Releases</TabsTrigger>
          <TabsTrigger value="review">Fuel Choices</TabsTrigger>
          <TabsTrigger value="efficiency">Fuel Efficiency</TabsTrigger>
          <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
          <TabsTrigger value="create">Push Flight</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="fbo"><ForeFlightClient /></TabsContent>
        <TabsContent value="tankering"><TankeringDashboard /></TabsContent>
        <TabsContent value="releases"><FleetFuelDashboard /></TabsContent>
        <TabsContent value="review"><FuelChoiceReview /></TabsContent>
        <TabsContent value="efficiency"><UnifiedFuelEfficiency /></TabsContent>
        <TabsContent value="dispatch"><DispatchFlights /></TabsContent>
        <TabsContent value="create"><CreateFlight /></TabsContent>
        <TabsContent value="webhooks"><WebhookEvents /></TabsContent>
      </Tabs>
    </>
  );
}
