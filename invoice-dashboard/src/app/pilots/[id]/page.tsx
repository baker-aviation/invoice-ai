export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { createServiceClient } from "@/lib/supabase/service";
import PilotDetailClient from "./PilotDetailClient";

export default async function PilotDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const pilotId = Number(id);

  if (Number.isNaN(pilotId)) {
    return (
      <>
        <Topbar title="Pilot" />
        <div className="p-6 text-red-600">Invalid pilot ID.</div>
      </>
    );
  }

  const supa = createServiceClient();
  const { data: pilot, error } = await supa
    .from("pilot_profiles")
    .select("*, pilot_onboarding_items(*)")
    .eq("id", pilotId)
    .single();

  if (error || !pilot) {
    return (
      <>
        <Topbar title="Pilot" />
        <div className="p-6 text-red-600">Pilot not found.</div>
      </>
    );
  }

  const items = pilot.pilot_onboarding_items ?? [];
  const { pilot_onboarding_items: _, ...profile } = pilot;

  return (
    <>
      <Topbar title={pilot.full_name} />
      <PilotDetailClient
        pilot={{
          ...profile,
          onboarding_items: items,
          onboarding_progress: {
            completed: items.filter((i: any) => i.completed).length,
            total: items.length,
          },
        }}
      />
    </>
  );
}
