import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/shared-plan/[token]/updated-at
 *
 * Lightweight endpoint for multi-user polling. Returns just the
 * updated_at timestamp — the client compares against its last-seen
 * value and shows a "reload" banner if the plan changed.
 * No auth required (same as shared-plan GET).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const supa = createServiceClient();
  const { data } = await supa
    .from("fuel_plan_links")
    .select("updated_at")
    .eq("token", token)
    .maybeSingle();

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    { updated_at: data.updated_at },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
