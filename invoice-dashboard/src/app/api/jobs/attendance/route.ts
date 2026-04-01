import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
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
  const urlMatch = input.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  const codeMatch = input.match(/^([a-z]{3}-[a-z]{4}-[a-z]{3})$/i);
  if (codeMatch) return codeMatch[1].toLowerCase();
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function normName(n: string): string {
  return n.toLowerCase().replace(/[^a-z]/g, "");
}

function getParam(params: any[], name: string): string {
  return params.find((p: any) => p.name === name)?.value ?? "";
}

function getIntParam(params: any[], name: string): number {
  return parseInt(params.find((p: any) => p.name === name)?.intValue ?? "0", 10);
}

// ─── Fetch ALL items from Admin Reports API (with pagination) ──────────

async function fetchReportsItems(token: string, meetingCode: string): Promise<{ items: any[]; usedCode: string }> {
  // Google stores meeting codes without dashes
  const codeVariants = [meetingCode, meetingCode.replace(/-/g, "")];

  for (const code of codeVariants) {
    const allItems: any[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL("https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/meet");
      url.searchParams.set("eventName", "call_ended");
      url.searchParams.set("filters", `meeting_code==${code}`);
      url.searchParams.set("maxResults", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) break;

      const data = await res.json();
      allItems.push(...(data.items ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    if (allItems.length > 0) {
      return { items: allItems, usedCode: code };
    }
  }

  return { items: [], usedCode: "" };
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
    const token = await getGoogleAccessToken();

    // 1. Fetch all items from Admin Reports API
    const { items, usedCode } = await fetchReportsItems(token, meetingCode);

    // 2. Parse ALL participants — both domain users and external/anonymous
    const byKey = new Map<string, {
      email: string;
      displayName: string;
      durationSec: number;
      date: string;
      isAnonymous: boolean;
    }>();

    for (const item of items) {
      const actorEmail = item.actor?.email?.toLowerCase() ?? "";
      const isAnonymous = item.actor?.callerType === "KEY";

      const eventTime = item.id?.time;
      const date = eventTime
        ? new Date(eventTime).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

      const params = item.events?.[0]?.parameters ?? [];
      const displayName = getParam(params, "display_name");
      const duration = getIntParam(params, "duration_seconds");

      // Dedup key: email+date for domain users, name+date for anonymous
      const key = actorEmail
        ? `${actorEmail}|${date}`
        : `${normName(displayName)}|anon|${date}`;

      const existing = byKey.get(key);
      if (existing) {
        existing.durationSec += duration;
        if (!existing.displayName && displayName) existing.displayName = displayName;
      } else {
        byKey.set(key, { email: actorEmail, displayName, durationSec: duration, date, isAnonymous });
      }
    }

    const participants = [...byKey.values()];

    // 3. Match against applicants
    const supa = createServiceClient();
    const { data: allApplicants } = await supa
      .from("job_application_parse")
      .select("application_id, candidate_name, email, pipeline_stage")
      .not("email", "is", null);

    const matched: { applicationId: number; name: string; email: string; durationSec: number; stage: string | null; date: string }[] = [];
    const unmatched: { name: string; email: string; durationMin: number; date: string }[] = [];
    const internal: { name: string; email: string; durationMin: number; date: string }[] = [];

    for (const p of participants) {
      // Internal Baker staff
      const isInternal = p.email &&
        (p.email.endsWith("@baker-aviation.com") || p.email.endsWith("@airninetwo.com"));

      if (isInternal) {
        internal.push({
          name: p.displayName || p.email.split("@")[0],
          email: p.email,
          durationMin: Math.round(p.durationSec / 60),
          date: p.date,
        });
        continue;
      }

      // External: try matching by email first, then display name
      let app = p.email
        ? (allApplicants ?? []).find((a) => a.email?.toLowerCase() === p.email)
        : null;

      if (!app && p.displayName) {
        const pNorm = normName(p.displayName);
        if (pNorm) {
          app = (allApplicants ?? []).find((a) => {
            if (!a.candidate_name) return false;
            return normName(a.candidate_name) === pNorm;
          }) ?? null;
        }
      }

      if (app) {
        matched.push({
          applicationId: app.application_id,
          name: app.candidate_name,
          email: p.email || app.email?.toLowerCase() || "",
          durationSec: p.durationSec,
          stage: app.pipeline_stage,
          date: p.date,
        });
      } else {
        unmatched.push({
          name: p.displayName || p.email || "Unknown",
          email: p.email,
          durationMin: Math.round(p.durationSec / 60),
          date: p.date,
        });
      }
    }

    // 4. Auto-mark attendance for matched applicants in info_session stage
    let markedCount = 0;
    for (const m of matched) {
      if (m.stage !== "info_session") continue;
      const { error } = await supa
        .from("job_application_parse")
        .update({
          info_session_attended: true,
          info_session_attended_at: new Date().toISOString(),
        })
        .eq("application_id", m.applicationId);

      if (!error) markedCount++;
    }

    // 5. Save attendance record
    const totalParticipants = matched.length + unmatched.length + internal.length;
    if (totalParticipants > 0) {
      await supa.from("info_session_attendance").insert({
        meeting_code: meetingCode,
        meet_link: meetLink,
        meeting_date: new Date().toISOString().split("T")[0],
        total_participants: totalParticipants,
        matched: matched.map((m) => ({ name: m.name, email: m.email, durationMin: Math.round(m.durationSec / 60), stage: m.stage, date: m.date })),
        unmatched: unmatched.map((u) => `${u.name}${u.email ? ` (${u.email})` : ""}`),
        checked_by: auth.email ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      meetingCode,
      totalParticipants,
      matched,
      markedCount,
      unmatched,
      internal,
      _debug: {
        meetLink,
        usedCode,
        rawItemCount: items.length,
        uniqueParticipants: participants.length,
        byType: {
          withEmail: participants.filter((p) => !!p.email).length,
          anonymous: participants.filter((p) => p.isAnonymous).length,
        },
      },
    });
  } catch (err) {
    console.error("[attendance] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
