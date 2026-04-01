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

async function getGoogleAccessToken(scopes: string[]): Promise<string> {
  const email = process.env.GOOGLE_MEET_SA_EMAIL;
  const rawKey = process.env.GOOGLE_MEET_SA_PRIVATE_KEY;
  const adminEmail = process.env.GOOGLE_MEET_ADMIN_EMAIL;

  if (!email || !rawKey || !adminEmail) {
    throw new Error("Missing GOOGLE_MEET_SA_EMAIL, GOOGLE_MEET_SA_PRIVATE_KEY, or GOOGLE_MEET_ADMIN_EMAIL");
  }

  const key = rawKey.replace(/\\n/g, "\n");
  const scope = scopes.join(" ");
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

// ─── Meet API v2 helpers ───────────────────────────────────────────────

interface MeetParticipant {
  name: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: { user: string; displayName: string };
  anonymousUser?: { displayName: string };
  phoneUser?: { displayName: string };
}

interface ConferenceRecord {
  name: string;
  startTime: string;
  endTime?: string;
  space: string;
}

/** Fetch all participants for a conference record (handles pagination) */
async function listParticipants(token: string, conferenceRecord: string): Promise<MeetParticipant[]> {
  const all: MeetParticipant[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://meet.googleapis.com/v2/${conferenceRecord}/participants`);
    url.searchParams.set("pageSize", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;

    const data = await res.json();
    all.push(...(data.participants ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all;
}

/** Resolve signed-in user IDs → emails via Admin Directory API (internal users only) */
async function resolveEmails(token: string, userIds: string[]): Promise<Map<string, string>> {
  const emailMap = new Map<string, string>();
  if (userIds.length === 0) return emailMap;

  const results = await Promise.allSettled(
    userIds.map(async (uid) => {
      const numericId = uid.replace("users/", "");
      const res = await fetch(
        `https://admin.googleapis.com/admin/directory/v1/users/${numericId}?projection=basic`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const user = await res.json();
      return { uid, email: (user.primaryEmail as string)?.toLowerCase() };
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value?.email) {
      emailMap.set(r.value.uid, r.value.email);
    }
  }
  return emailMap;
}

/** Normalize a name for fuzzy comparison */
function normName(n: string): string {
  return n.toLowerCase().replace(/[^a-z]/g, "");
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
    // 1. Get tokens — Meet API + Admin Directory for email resolution
    const meetToken = await getGoogleAccessToken([
      "https://www.googleapis.com/auth/meetings.space.readonly",
    ]);
    const adminToken = await getGoogleAccessToken([
      "https://www.googleapis.com/auth/admin.directory.user.readonly",
    ]);

    // 2. Look up the space by meeting code
    const spaceRes = await fetch(`https://meet.googleapis.com/v2/spaces/${meetingCode}`, {
      headers: { Authorization: `Bearer ${meetToken}` },
    });

    if (!spaceRes.ok) {
      const text = await spaceRes.text();
      return NextResponse.json({
        error: `Google Meet space lookup failed (${spaceRes.status}). ` +
          (spaceRes.status === 403
            ? "The Google Meet REST API may not be enabled or the service account lacks the meetings.space.readonly scope. " +
              "Enable it at: console.cloud.google.com → APIs & Services → Enable 'Google Meet REST API', " +
              "then add the scope in Admin Console → Security → API Controls → Domain-wide Delegation."
            : text.slice(0, 500)),
      }, { status: 502 });
    }

    const space = await spaceRes.json();
    const spaceName: string = space.name; // "spaces/xxxxx"

    // 3. List all conference records for this space
    let conferences: ConferenceRecord[] = [];
    let confPageToken: string | undefined;
    do {
      const confUrl = new URL("https://meet.googleapis.com/v2/conferenceRecords");
      confUrl.searchParams.set("filter", `space.name="${spaceName}"`);
      confUrl.searchParams.set("pageSize", "100");
      if (confPageToken) confUrl.searchParams.set("pageToken", confPageToken);

      const confRes = await fetch(confUrl.toString(), {
        headers: { Authorization: `Bearer ${meetToken}` },
      });
      if (!confRes.ok) break;

      const confData = await confRes.json();
      conferences.push(...(confData.conferenceRecords ?? []));
      confPageToken = confData.nextPageToken;
    } while (confPageToken);

    if (conferences.length === 0) {
      return NextResponse.json({
        ok: true,
        meetingCode,
        totalParticipants: 0,
        matched: [],
        markedCount: 0,
        unmatched: [],
        internal: [],
        _debug: { meetLink, spaceName, conferencesFound: 0 },
      });
    }

    // 4. Fetch participants from all conference records (parallel)
    const allRawParticipants: { participant: MeetParticipant; sessionDate: string }[] = [];

    await Promise.all(
      conferences.map(async (conf) => {
        const participants = await listParticipants(meetToken, conf.name);
        const date = conf.startTime
          ? new Date(conf.startTime).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        for (const p of participants) {
          allRawParticipants.push({ participant: p, sessionDate: date });
        }
      }),
    );

    // 5. Collect unique signed-in user IDs for email resolution
    const signedInUserIds = new Set<string>();
    for (const { participant } of allRawParticipants) {
      if (participant.signedinUser?.user) {
        signedInUserIds.add(participant.signedinUser.user);
      }
    }

    const emailMap = await resolveEmails(adminToken, [...signedInUserIds]);

    // 6. Deduplicate participants by (identifier + date)
    //    identifier = resolved email for signed-in users, or displayName for anonymous/phone
    interface ResolvedParticipant {
      displayName: string;
      email: string; // empty string if unknown
      durationSec: number;
      date: string;
      type: "signedin" | "anonymous" | "phone";
    }

    const byKey = new Map<string, ResolvedParticipant>();

    for (const { participant: p, sessionDate } of allRawParticipants) {
      let displayName = "";
      let email = "";
      let type: ResolvedParticipant["type"] = "anonymous";

      if (p.signedinUser) {
        displayName = p.signedinUser.displayName ?? "";
        email = emailMap.get(p.signedinUser.user) ?? "";
        type = "signedin";
      } else if (p.anonymousUser) {
        displayName = p.anonymousUser.displayName ?? "Anonymous";
        type = "anonymous";
      } else if (p.phoneUser) {
        displayName = p.phoneUser.displayName ?? "Phone User";
        type = "phone";
      }

      // Duration from earliest join to latest leave
      let durationSec = 0;
      if (p.earliestStartTime && p.latestEndTime) {
        durationSec = Math.round(
          (new Date(p.latestEndTime).getTime() - new Date(p.earliestStartTime).getTime()) / 1000,
        );
      }

      const key = email
        ? `${email}|${sessionDate}`
        : `${normName(displayName)}|${type}|${sessionDate}`;

      const existing = byKey.get(key);
      if (existing) {
        // Keep longer duration (participant may have multiple sessions)
        if (durationSec > existing.durationSec) existing.durationSec = durationSec;
        if (!existing.displayName && displayName) existing.displayName = displayName;
        if (!existing.email && email) existing.email = email;
      } else {
        byKey.set(key, { displayName, email, durationSec, date: sessionDate, type });
      }
    }

    const participants = [...byKey.values()];

    // 7. Match against applicants (by email first, then display name)
    const supa = createServiceClient();
    const { data: allApplicants } = await supa
      .from("job_application_parse")
      .select("application_id, candidate_name, email, pipeline_stage")
      .not("email", "is", null);

    const matched: { applicationId: number; name: string; email: string; durationSec: number; stage: string | null; date: string }[] = [];
    const unmatched: { name: string; email: string; durationMin: number; date: string }[] = [];
    const internal: { name: string; email: string; durationMin: number; date: string }[] = [];

    for (const p of participants) {
      // Check if internal Baker staff (by resolved email)
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

      // Try matching applicant by email first, then display name
      let app = p.email
        ? (allApplicants ?? []).find((a) => a.email?.toLowerCase() === p.email)
        : null;

      if (!app && p.displayName) {
        const pNorm = normName(p.displayName);
        app = (allApplicants ?? []).find((a) => {
          if (!a.candidate_name) return false;
          return normName(a.candidate_name) === pNorm;
        }) ?? null;
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

    // 8. Auto-mark attendance for matched applicants in info_session stage
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

    // 9. Save attendance record
    if (participants.length > 0) {
      await supa.from("info_session_attendance").insert({
        meeting_code: meetingCode,
        meet_link: meetLink,
        meeting_date: new Date().toISOString().split("T")[0],
        total_participants: participants.length,
        matched: matched.map((m) => ({ name: m.name, email: m.email, durationMin: Math.round(m.durationSec / 60), stage: m.stage, date: m.date })),
        unmatched: unmatched.map((u) => `${u.name}${u.email ? ` (${u.email})` : ""}`),
        checked_by: auth.email ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      meetingCode,
      totalParticipants: participants.length,
      matched,
      markedCount,
      unmatched,
      internal,
      _debug: {
        meetLink,
        spaceName,
        conferencesFound: conferences.length,
        signedInResolved: emailMap.size,
        signedInTotal: signedInUserIds.size,
        participantsByType: {
          signedin: participants.filter((p) => p.type === "signedin").length,
          anonymous: participants.filter((p) => p.type === "anonymous").length,
          phone: participants.filter((p) => p.type === "phone").length,
        },
      },
    });
  } catch (err) {
    console.error("[attendance] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
