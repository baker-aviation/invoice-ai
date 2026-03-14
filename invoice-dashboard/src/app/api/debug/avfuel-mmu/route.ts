import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";

export async function GET() {
  const supa = createServiceClient();

  // Check all Avfuel rows for MMU
  const { data, error } = await supa
    .from("fbo_advertised_prices")
    .select("id, fbo_vendor, airport_code, volume_tier, product, price, tail_numbers, week_start, created_at")
    .eq("fbo_vendor", "Avfuel")
    .ilike("airport_code", "%MMU%")
    .order("week_start", { ascending: false });

  // Total row count in 2-week window (exact count, not limited by max_rows)
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const { count: totalRecent } = await supa
    .from("fbo_advertised_prices")
    .select("id", { count: "exact", head: true })
    .gte("week_start", cutoff);

  // Call the actual function used by the page to see how many rows it returns
  const actualData = await fetchAdvertisedPrices();
  const avfuelInActual = actualData.filter(a => a.fbo_vendor === "Avfuel" && a.airport_code.includes("MMU") && !a.airport_code.includes("MMUN"));
  const vendorCounts: Record<string, number> = {};
  for (const a of actualData) {
    vendorCounts[a.fbo_vendor] = (vendorCounts[a.fbo_vendor] ?? 0) + 1;
  }

  return NextResponse.json({
    avfuelMmuInDb: data?.length ?? 0,
    avfuelMmuInFetchResult: avfuelInActual.length,
    avfuelMmuData: avfuelInActual,
    fetchAdvertisedPricesTotalRows: actualData.length,
    vendorCounts,
    totalRecentRowsInDb: totalRecent,
    cutoff,
    error: error?.message,
  });
}
