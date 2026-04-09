import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/fbo-fees/outreach-status
 *
 * Returns all fee request records for the outreach dashboard.
 */
export async function GET() {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("fbo_fee_requests")
    .select("id, airport_code, fbo_name, fbo_email, status, sent_at, reply_received_at, parsed_at, parse_confidence, batch_id, reply_body, reply_from")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(1000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ requests: data ?? [] });
}
