import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// ─── GET: fetch recent attendance history ──────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400_000).toISOString().split("T")[0];

  const { data, error } = await supa
    .from("info_session_attendance")
    .select("id, meeting_code, meet_link, meeting_date, total_participants, matched, unmatched, checked_by, created_at")
    .gte("meeting_date", twoWeeksAgo)
    .order("meeting_date", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, records: data ?? [] });
}

// ─── Google Auth: JWT → Access Token ───────────────────────────────────

async function getGoogleAccessToken(): Promise<string> {
  const email = process.env.GOOGLE_MEET_SA_EMAIL;
  const rawKey = process.env.GOOGLE_MEET_SA_PRIVATE_KEY;
  const adminEmail = process.env.GOOGLE_MEET_ADMIN_EMAIL;

  if (!email || !rawKey || !adminEmail) {
    throw new Error("Missing GOOGLE_MEET_SA_EMAIL, GOOGLE_MEET_SA_PRIVATE_KEY, or GOOGLE_MEET_ADMIN_EMAIL");
  }

  const key = rawKey.replace(/\\n/g, "\n");
  const scope = "https://www.googleapis.com/auth/admin.reports.audit.readonly";
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: email,
    sub: adminEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Import PEM key and sign
  const pemBody = key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binaryKey = Buffer.from(pemBody, "base64");

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  const jwt = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;

  // Exchange JWT for access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ─── Extract meeting code from URL ─────────────────────────────────────

function extractMeetingCode(input: string): string | null {
  // "https://meet.google.com/esm-cnwb-xxx" → "esm-cnwb-xxx"
  const urlMatch = input.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  // Already a code like "esm-cnwb-xxx"
  const codeMatch = input.match(/^([a-z]{3}-[a-z]{4}-[a-z]{3})$/i);
  if (codeMatch) return codeMatch[1].toLowerCase();
  return null;
}

// ─── Main endpoint ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: { meetLink?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const meetLink = body.meetLink;
  if (!meetLink) {
    return NextResponse.json({ error: "meetLink is required" }, { status: 400 });
  }

  const meetingCode = extractMeetingCode(meetLink);
  if (!meetingCode) {
    return NextResponse.json({ error: `Could not extract meeting code from: ${meetLink}` }, { status: 400 });
  }

  try {
    // 1. Get Google access token
    const token = await getGoogleAccessToken();

    // 2. Query Admin Reports API for call_ended events with this meeting code
    const reportsUrl = new URL("https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/meet");
    reportsUrl.searchParams.set("eventName", "call_ended");
    reportsUrl.searchParams.set("filters", `meeting_code==${meetingCode}`);
    reportsUrl.searchParams.set("maxResults", "200");

    const reportsRes = await fetch(reportsUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!reportsRes.ok) {
      const text = await reportsRes.text();
      return NextResponse.json({
        error: `Google Reports API error (${reportsRes.status}): ${text.slice(0, 500)}`,
      }, { status: 502 });
    }

    const reportsData = await reportsRes.json();
    const items = reportsData.items ?? [];

    // 3. Extract participant emails from events
    const participants: { email: string; displayName: string; durationSec: number }[] = [];
    for (const item of items) {
      const email = item.actor?.email;
      if (!email) continue;

      const params = item.events?.[0]?.parameters ?? [];
      const displayName = params.find((p: any) => p.name === "display_name")?.value ?? "";
      const duration = params.find((p: any) => p.name === "duration_seconds")?.intValue ?? "0";

      participants.push({
        email: email.toLowerCase(),
        displayName,
        durationSec: parseInt(duration, 10),
      });
    }

    // 4. Match against applicants in the info_session pipeline stage
    const supa = createServiceClient();
    const { data: applicants } = await supa
      .from("job_application_parse")
      .select("application_id, candidate_name, email, pipeline_stage")
      .eq("pipeline_stage", "info_session");

    const matched: { applicationId: number; name: string; email: string; durationSec: number }[] = [];
    const unmatched: string[] = [];

    const applicantEmails = new Set(
      (applicants ?? []).filter((a) => a.email).map((a) => a.email!.toLowerCase()),
    );

    for (const p of participants) {
      const app = (applicants ?? []).find(
        (a) => a.email?.toLowerCase() === p.email,
      );
      if (app) {
        matched.push({
          applicationId: app.application_id,
          name: app.candidate_name,
          email: p.email,
          durationSec: p.durationSec,
        });
      } else {
        // Don't list internal baker emails as unmatched
        if (!p.email.endsWith("@baker-aviation.com") && !p.email.endsWith("@airninetwo.com")) {
          unmatched.push(`${p.displayName || p.email} (${p.email})`);
        }
      }
    }

    // 5. Auto-mark attendance for matched applicants
    let markedCount = 0;
    for (const m of matched) {
      const { error } = await supa
        .from("job_application_parse")
        .update({
          info_session_attended: true,
          info_session_attended_at: new Date().toISOString(),
        })
        .eq("application_id", m.applicationId);

      if (!error) markedCount++;
    }

    // 6. Save attendance record
    await supa.from("info_session_attendance").insert({
      meeting_code: meetingCode,
      meet_link: meetLink,
      meeting_date: new Date().toISOString().split("T")[0],
      total_participants: participants.length,
      matched: matched.map((m) => ({ name: m.name, email: m.email, durationMin: Math.round(m.durationSec / 60) })),
      unmatched,
      checked_by: auth.email ?? null,
    });

    return NextResponse.json({
      ok: true,
      meetingCode,
      totalParticipants: participants.length,
      matched,
      markedCount,
      unmatched,
    });
  } catch (err) {
    console.error("[attendance] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
