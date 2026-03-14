import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET() {
  const supa = createServiceClient();

  // Check all Avfuel rows for MMU
  const { data, error } = await supa
    .from("fbo_advertised_prices")
    .select("id, fbo_vendor, airport_code, volume_tier, product, price, tail_numbers, week_start, created_at")
    .eq("fbo_vendor", "Avfuel")
    .ilike("airport_code", "%MMU%")
    .order("week_start", { ascending: false });

  // Also check total Avfuel row count
  const { count } = await supa
    .from("fbo_advertised_prices")
    .select("id", { count: "exact", head: true })
    .eq("fbo_vendor", "Avfuel");

  // Total row count in 2-week window
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const { count: totalRecent } = await supa
    .from("fbo_advertised_prices")
    .select("id", { count: "exact", head: true })
    .gte("week_start", cutoff);

  return NextResponse.json({
    avfuelMmuRows: data?.length ?? 0,
    avfuelMmuData: data,
    totalAvfuelRows: count,
    totalRecentRows: totalRecent,
    cutoff,
    error: error?.message,
  });
}
