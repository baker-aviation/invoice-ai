import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireAdmin, isRateLimited, isAuthed } from "@/lib/api-auth";
import { ALL_SECTION_KEYS } from "@/lib/permissions";

const VALID_ROLES = ["admin", "dashboard", "pilot", "chief_pilot", "mx", "van"] as const;

const UpdateRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  role: z.enum(VALID_ROLES),
});

const DeleteUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

/**
 * GET /api/admin/users — List all users with their roles.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) {
    return NextResponse.json({ error: "Failed to list users" }, { status: 500 });
  }

  const users = data.users.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.app_metadata?.role ?? u.user_metadata?.role ?? null,
    permissions: (u.app_metadata?.permissions as string[] | undefined) ?? [],
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
  }));

  return NextResponse.json({ users });
}

/**
 * PUT /api/admin/users — Update a user's role.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = UpdateRoleSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  // Prevent admins from demoting themselves
  if (parsed.data.userId === auth.userId && parsed.data.role !== "admin") {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { error } = await supabase.auth.admin.updateUserById(parsed.data.userId, {
    app_metadata: { role: parsed.data.role },
  });

  if (error) {
    return NextResponse.json({ error: "Failed to update role" }, { status: 500 });
  }

  return NextResponse.json({ success: true, userId: parsed.data.userId, role: parsed.data.role });
}

/**
 * PATCH /api/admin/users — Update a user's section permissions.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const UpdatePermissionsSchema = z.object({
    userId: z.string().uuid("Invalid user ID"),
    permissions: z.array(z.enum(ALL_SECTION_KEYS as unknown as [string, ...string[]])),
  });

  const parsed = UpdatePermissionsSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { error } = await supabase.auth.admin.updateUserById(parsed.data.userId, {
    app_metadata: { permissions: parsed.data.permissions },
  });

  if (error) {
    return NextResponse.json({ error: "Failed to update permissions" }, { status: 500 });
  }

  return NextResponse.json({ success: true, userId: parsed.data.userId, permissions: parsed.data.permissions });
}

/**
 * DELETE /api/admin/users — Delete a user account.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = DeleteUserSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  // Prevent admins from deleting themselves
  if (parsed.data.userId === auth.userId) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { error } = await supabase.auth.admin.deleteUser(parsed.data.userId);

  if (error) {
    return NextResponse.json({ error: "Failed to delete user" }, { status: 500 });
  }

  return NextResponse.json({ success: true, userId: parsed.data.userId });
}
