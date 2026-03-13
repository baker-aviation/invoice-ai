import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getItemsForRole } from "@/lib/onboardingItems";

export const dynamic = "force-dynamic";

/** GET /api/pilots — list all pilot profiles with onboarding progress */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data: pilots, error } = await supa
    .from("pilot_profiles")
    .select("*, pilot_onboarding_items(*)")
    .order("full_name");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const enriched = (pilots ?? []).map((p: any) => {
    const items = p.pilot_onboarding_items ?? [];
    const total = items.length;
    const completed = items.filter((i: any) => i.completed).length;
    const { pilot_onboarding_items: _, ...profile } = p;
    return { ...profile, onboarding_progress: { completed, total } };
  });

  return NextResponse.json({ ok: true, count: enriched.length, pilots: enriched });
}

/** POST /api/pilots — create a new pilot profile + seed onboarding items */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const {
    full_name, email, phone, role, home_airports, aircraft_types,
    hire_date, employee_id, medical_class, medical_expiry, passport_expiry,
    user_id, crew_member_id, application_id,
  } = body;

  if (!full_name || !role || !["PIC", "SIC"].includes(role)) {
    return NextResponse.json(
      { ok: false, error: "full_name and role (PIC|SIC) are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();

  // Insert pilot profile
  const { data: pilot, error: insertErr } = await supa
    .from("pilot_profiles")
    .insert({
      full_name, email, phone, role,
      home_airports: home_airports ?? [],
      aircraft_types: aircraft_types ?? [],
      hire_date: hire_date ?? null,
      employee_id: employee_id ?? null,
      medical_class: medical_class ?? null,
      medical_expiry: medical_expiry ?? null,
      passport_expiry: passport_expiry ?? null,
      user_id: user_id ?? null,
      crew_member_id: crew_member_id ?? null,
      application_id: application_id ?? null,
    })
    .select()
    .single();

  if (insertErr) {
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  // Seed onboarding items based on role
  const items = getItemsForRole(role as "PIC" | "SIC");
  const rows = items.map((item) => ({
    pilot_profile_id: pilot.id,
    item_key: item.key,
    item_label: item.label,
    required_for: item.required_for,
  }));

  if (rows.length > 0) {
    const { error: seedErr } = await supa
      .from("pilot_onboarding_items")
      .insert(rows);

    if (seedErr) {
      return NextResponse.json({ ok: false, error: seedErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, pilot }, { status: 201 });
}
