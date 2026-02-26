import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { emails } = await req.json();

  if (!Array.isArray(emails) || emails.length === 0) {
    return NextResponse.json({ error: "No emails provided" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results: { email: string; status: string; error?: string }[] = [];

  for (const email of emails) {
    const { error } = await supabase.auth.admin.inviteUserByEmail(email);
    results.push({
      email,
      status: error ? "failed" : "sent",
      ...(error ? { error: error.message } : {}),
    });
  }

  return NextResponse.json({ results });
}
