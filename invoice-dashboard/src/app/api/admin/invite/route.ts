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
  const results: { email: string; status: string; error?: string; link?: string }[] = [];

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.get("host")}`;

  for (const email of parsed.data.emails) {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: "invite",
      email,
      options: {
        redirectTo: `${siteUrl}/auth/callback?next=/login/reset`,
      },
    });

    if (error || !data?.properties?.hashed_token) {
      results.push({ email, status: "failed", error: error?.message ?? "No link generated" });
    } else {
      // Build the verification URL that goes through Supabase's verify endpoint
      const token = data.properties.hashed_token;
      const verifyUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/verify?token=${token}&type=invite&redirect_to=${encodeURIComponent(`${siteUrl}/auth/callback?next=/login/reset`)}`;
      results.push({ email, status: "link_generated", link: verifyUrl });
    }
  }

  return NextResponse.json({ results });
}
