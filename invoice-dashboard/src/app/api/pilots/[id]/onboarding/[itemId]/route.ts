import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** PATCH /api/pilots/[id]/onboarding/[itemId] — toggle onboarding item completion */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id, itemId } = await params;
  const pilotId = Number(id);
  const onboardingItemId = Number(itemId);

  if (Number.isNaN(pilotId) || Number.isNaN(onboardingItemId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await req.json();
  const completed = Boolean(body.completed);
  const notes = body.notes ?? null;

  const supa = createServiceClient();

  // Update the onboarding item
  const { data: item, error } = await supa
    .from("pilot_onboarding_items")
    .update({
      completed,
      completed_at: completed ? new Date().toISOString() : null,
      completed_by: completed ? auth.userId : null,
      notes,
    })
    .eq("id", onboardingItemId)
    .eq("pilot_profile_id", pilotId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Check if all required items are now complete → auto-set onboarding_complete
  const { data: allItems } = await supa
    .from("pilot_onboarding_items")
    .select("completed")
    .eq("pilot_profile_id", pilotId);

  const allComplete = (allItems ?? []).every((i: any) => i.completed);

  await supa
    .from("pilot_profiles")
    .update({
      onboarding_complete: allComplete,
      available_to_fly: allComplete,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pilotId);

  return NextResponse.json({ ok: true, item, onboarding_complete: allComplete });
}
