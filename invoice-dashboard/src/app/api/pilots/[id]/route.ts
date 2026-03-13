import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET /api/pilots/[id] — pilot detail with onboarding items */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const pilotId = Number(id);
  if (Number.isNaN(pilotId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: pilot, error } = await supa
    .from("pilot_profiles")
    .select("*, pilot_onboarding_items(*)")
    .eq("id", pilotId)
    .single();

  if (error || !pilot) {
    return NextResponse.json({ ok: false, error: "Pilot not found" }, { status: 404 });
  }

  const items = pilot.pilot_onboarding_items ?? [];
  const { pilot_onboarding_items: _, ...profile } = pilot;

  return NextResponse.json({
    ok: true,
    pilot: {
      ...profile,
      onboarding_items: items,
      onboarding_progress: {
        completed: items.filter((i: any) => i.completed).length,
        total: items.length,
      },
    },
  });
}

/** PATCH /api/pilots/[id] — update pilot profile fields */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const pilotId = Number(id);
  if (Number.isNaN(pilotId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await req.json();
  const allowedFields = [
    "full_name", "email", "phone", "role", "home_airports", "aircraft_types",
    "hire_date", "employee_id", "medical_class", "medical_expiry", "passport_expiry",
    "user_id", "crew_member_id", "available_to_fly",
  ];

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key];
  }

  const supa = createServiceClient();
  const { data: pilot, error } = await supa
    .from("pilot_profiles")
    .update(updates)
    .eq("id", pilotId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, pilot });
}
