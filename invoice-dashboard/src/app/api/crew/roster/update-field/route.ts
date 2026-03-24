import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const ALLOWED_FIELDS = new Set(["grade", "checkairman_types", "restrictions", "is_checkairman", "notes", "active"]);

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { id, field, value } = body;

  if (!id || !field) {
    return NextResponse.json({ error: "id and field required" }, { status: 400 });
  }

  if (!ALLOWED_FIELDS.has(field)) {
    return NextResponse.json({ error: `Field '${field}' not allowed` }, { status: 400 });
  }

  // Validate grade range
  if (field === "grade") {
    const grade = Number(value);
    if (!Number.isInteger(grade) || grade < 1 || grade > 4) {
      return NextResponse.json({ error: "Grade must be 1-4" }, { status: 400 });
    }
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("crew_members")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
