import { createServiceClient } from "@/lib/supabase/service";
import { FIXED_VAN_ZONES } from "@/lib/maintenanceData";
import { notFound } from "next/navigation";
import VanDriverClient from "./VanDriverClient";

export const dynamic = "force-dynamic";

export default async function VanPage({ params }: { params: Promise<{ vanId: string }> }) {
  const { vanId: vanIdStr } = await params;
  const vanId = parseInt(vanIdStr, 10);

  // Validate vanId
  const zone = FIXED_VAN_ZONES.find((z) => z.vanId === vanId);
  if (!zone) return notFound();

  // Fetch flights from Supabase (same query as ops page)
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  const { data: flights } = await supa
    .from("flights")
    .select("*")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  return <VanDriverClient vanId={vanId} zone={zone} initialFlights={flights ?? []} />;
}
