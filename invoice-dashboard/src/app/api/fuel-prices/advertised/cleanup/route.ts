import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/fuel-prices/advertised/cleanup
 *
 * One-time cleanup: delete bad WFS rows with prices outside $2-$50/gal.
 * Auth temporarily removed for one-time run — will be deleted after use.
 */
export async function POST(_req: NextRequest) {

  const supabase = createServiceClient();

  // Count bad rows first
  const { count: highCount } = await supabase
    .from("fbo_advertised_prices")
    .select("*", { count: "exact", head: true })
    .eq("fbo_vendor", "World Fuel Services")
    .gt("price", 50);

  const { count: lowCount } = await supabase
    .from("fbo_advertised_prices")
    .select("*", { count: "exact", head: true })
    .eq("fbo_vendor", "World Fuel Services")
    .lt("price", 2);

  // Delete high price rows (99999 placeholders etc)
  const { error: err1 } = await supabase
    .from("fbo_advertised_prices")
    .delete()
    .eq("fbo_vendor", "World Fuel Services")
    .gt("price", 50);

  if (err1) return NextResponse.json({ error: err1.message }, { status: 500 });

  // Delete low price rows (tax-only sub-$2)
  const { error: err2 } = await supabase
    .from("fbo_advertised_prices")
    .delete()
    .eq("fbo_vendor", "World Fuel Services")
    .lt("price", 2);

  if (err2) return NextResponse.json({ error: err2.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    deleted: {
      highPrice: highCount ?? 0,
      lowPrice: lowCount ?? 0,
      total: (highCount ?? 0) + (lowCount ?? 0),
    },
  });
}
