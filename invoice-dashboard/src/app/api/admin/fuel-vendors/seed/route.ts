import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const SEED_VENDORS = [
  // Domestic
  { name: "Everest", slug: "everest", contact_email: "fuelmanagement@everest-fuel.com", release_type: "email", is_international: false, requires_destination: false, notes: null },
  { name: "EVO", slug: "evo", contact_email: "orderfuel@flyevo.com", release_type: "email", is_international: false, requires_destination: false, notes: null },
  { name: "AEG", slug: "aeg", contact_email: "dispatch@aegfuels.com", release_type: "email", is_international: false, requires_destination: false, notes: null },
  { name: "World Fuels", slug: "wfs", contact_email: "fuel24@wfscorp.com", release_type: "email", is_international: false, requires_destination: false, notes: null },
  // International
  { name: "AvFuel", slug: "avfuel", contact_email: "contractfuel@avfuel.com", release_type: "email", is_international: true, requires_destination: true, notes: "They will also want destination" },
  { name: "Everest (Intl)", slug: "everest-intl", contact_email: "fuelmanagement@everest-fuel.com", release_type: "email", is_international: true, requires_destination: true, notes: "They will also want destination" },
  { name: "EVO (Intl)", slug: "evo-intl", contact_email: "orderfuel@flyevo.com", release_type: "email", is_international: true, requires_destination: false, notes: null },
  { name: "AEG (Intl)", slug: "aeg-intl", contact_email: "dispatch@aegfuels.com", release_type: "email", is_international: true, requires_destination: false, notes: null },
  { name: "World Fuels (Intl)", slug: "wfs-intl", contact_email: "fuel24@wfscorp.com", release_type: "email", is_international: true, requires_destination: false, notes: null },
  { name: "Titan (Intl)", slug: "titan-intl", contact_email: "eudispatch@titanfuels.aero", release_type: "email", is_international: true, requires_destination: false, notes: null },
  // Physical card
  { name: "Signature", slug: "signature", contact_email: null, release_type: "card", is_international: false, requires_destination: false, notes: "Use Physical Horizon Card" },
  { name: "Retail", slug: "retail", contact_email: null, release_type: "card", is_international: false, requires_destination: false, notes: "Use Physical Horizon Card" },
];

/**
 * POST /api/admin/fuel-vendors/seed
 *
 * Upsert the default fuel vendors. Safe to call multiple times — uses
 * ON CONFLICT on slug to update existing rows.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fuel_vendors")
    .upsert(SEED_VENDORS.map((v) => ({ ...v, active: true })), {
      onConflict: "slug",
      ignoreDuplicates: false,
    })
    .select("id, name, slug");

  if (error) {
    console.error("[fuel-vendors/seed] Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, count: data?.length ?? 0, vendors: data });
}
