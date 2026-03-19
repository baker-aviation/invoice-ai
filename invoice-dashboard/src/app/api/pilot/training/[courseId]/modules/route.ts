import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const CreateModuleSchema = z.object({
  title: z.string().min(1).max(200),
  sort_order: z.number().int().min(0).max(9999).optional(),
}).strip();

/**
 * GET /api/pilot/training/[courseId]/modules — list modules
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { courseId } = await params;
  const id = Number(courseId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid course ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_modules")
    .select("*")
    .eq("course_id", id)
    .order("sort_order", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ modules: data });
}

/**
 * POST /api/pilot/training/[courseId]/modules — create module (admin only)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { courseId } = await params;
  const id = Number(courseId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid course ID" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateModuleSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_modules")
    .insert({
      course_id: id,
      title: parsed.data.title.trim(),
      sort_order: parsed.data.sort_order ?? 0,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ module: data }, { status: 201 });
}
