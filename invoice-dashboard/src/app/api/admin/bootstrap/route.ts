import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireAuth, isAuthed } from "@/lib/api-auth";

/**
 * POST /api/admin/bootstrap
 *
 * One-time admin bootstrap: if no admins exist yet, promotes the requesting
 * user to admin. If admins already exist, requires admin auth to promote
 * another user by email.
 *
 * Body: { email?: string } — omit to promote self, provide to promote another user.
 */
export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const adminClient = createClient(supabaseUrl, serviceKey);

  // Check if any admins exist
  const { data: allUsers } = await adminClient.auth.admin.listUsers({ perPage: 200 });
  const existingAdmins = (allUsers?.users ?? []).filter(
    (u) => u.app_metadata?.role === "admin",
  );

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // No body = promote self
  }

  const targetEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : auth.email.toLowerCase();

  // If admins exist, only admins can promote
  if (existingAdmins.length > 0 && auth.role !== "admin") {
    return NextResponse.json(
      { error: "Admins already exist. Only an admin can promote users." },
      { status: 403 },
    );
  }

  // Find the target user
  const targetUser = (allUsers?.users ?? []).find(
    (u) => u.email?.toLowerCase() === targetEmail,
  );

  if (!targetUser) {
    return NextResponse.json({ error: `User ${targetEmail} not found` }, { status: 404 });
  }

  // Promote to admin
  const { error } = await adminClient.auth.admin.updateUserById(targetUser.id, {
    app_metadata: { ...targetUser.app_metadata, role: "admin" },
  });

  if (error) {
    return NextResponse.json({ error: `Failed: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    promoted: targetEmail,
    message: `${targetEmail} is now an admin`,
  });
}
