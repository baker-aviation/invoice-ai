import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireAdmin, isRateLimited, isAuthed } from "@/lib/api-auth";

const EmailsSchema = z.object({
  emails: z
    .array(z.string().email("Invalid email address"))
    .min(1, "At least one email required")
    .max(20, "Maximum 20 invites per request"),
});

export async function POST(req: NextRequest) {
  // 1. Require admin auth
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  // 2. Rate limit — 10 invites per minute per admin
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  // 3. Validate body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = EmailsSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  // 4. Send invites using service role
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const results: { email: string; status: string; error?: string }[] = [];

  for (const email of parsed.data.emails) {
    const { error } = await supabase.auth.admin.inviteUserByEmail(email);
    results.push({
      email,
      status: error ? "failed" : "sent",
      ...(error ? { error: error.message } : {}),
    });
  }

  return NextResponse.json({ results });
}
