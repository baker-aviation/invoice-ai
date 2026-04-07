import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { GROUND_CATEGORIES } from "@/lib/groundPipeline";

const PILOT_CATEGORIES = ["pilot_pic", "pilot_sic", "skillbridge", "dispatcher"];
const ALL_VALID = [...PILOT_CATEGORIES, ...(GROUND_CATEGORIES as readonly string[])];

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;

    const body = await req.json();
    const { id, newCategory } = body;

    if (!id || !newCategory) {
      return NextResponse.json({ ok: false, error: "Missing id or newCategory" }, { status: 400 });
    }

    if (!ALL_VALID.includes(newCategory)) {
      return NextResponse.json({ ok: false, error: `Invalid category: ${newCategory}` }, { status: 400 });
    }

    const supa = createServiceClient();

    const { error } = await supa
      .from("job_application_parse")
      .update({
        category: newCategory,
        pipeline_stage: "",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, newCategory, resetPipeline: true });
  } catch (e: any) {
    console.error("[reassign] Error:", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Internal error" }, { status: 500 });
  }
}
