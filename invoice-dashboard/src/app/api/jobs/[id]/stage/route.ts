import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PIPELINE_STAGES } from "@/lib/types";
import { getItemsForRole } from "@/lib/onboardingItems";

const SAFE_ID_RE = /^\d+$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  if (!SAFE_ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  let body: { stage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stage = body.stage;
  if (!stage || !(PIPELINE_STAGES as readonly string[]).includes(stage)) {
    return NextResponse.json(
      { error: `Invalid stage. Must be one of: ${PIPELINE_STAGES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const supa = createServiceClient();
    const { data } = await supa
      .from("job_application_parse")
      .update({ pipeline_stage: stage })
      .eq("application_id", Number(id))
      .select("id");

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Auto-create pilot profile when moved to "hired"
    if (stage === "hired") {
      try {
        // Fetch the candidate info
        const { data: app } = await supa
          .from("job_application_parse")
          .select("candidate_name, email, phone, category")
          .eq("application_id", Number(id))
          .single();

        if (app?.candidate_name) {
          // Guard: skip if pilot_profiles already exists for this application_id
          const { data: existing } = await supa
            .from("pilot_profiles")
            .select("id")
            .eq("application_id", Number(id))
            .maybeSingle();

          if (!existing) {
            const role = app.category?.toLowerCase().includes("pic") ? "PIC" : "SIC";

            const { data: pilot } = await supa
              .from("pilot_profiles")
              .insert({
                full_name: app.candidate_name,
                email: app.email ?? null,
                phone: app.phone ?? null,
                role,
                application_id: Number(id),
                hire_date: new Date().toISOString().split("T")[0],
                home_airports: [],
                aircraft_types: [],
              })
              .select()
              .single();

            if (pilot) {
              const items = getItemsForRole(role);
              const rows = items.map((item) => ({
                pilot_profile_id: pilot.id,
                item_key: item.key,
                item_label: item.label,
                required_for: item.required_for,
              }));
              if (rows.length > 0) {
                await supa.from("pilot_onboarding_items").insert(rows);
              }
            }
          }
        }
      } catch (err) {
        // Log but don't fail the stage update
        console.error("[jobs/stage] Failed to auto-create pilot profile:", err);
      }
    }

    return NextResponse.json({ ok: true, stage });
  } catch (err) {
    console.error("[jobs/stage] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
