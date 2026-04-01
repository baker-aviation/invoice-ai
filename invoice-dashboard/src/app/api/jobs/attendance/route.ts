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

async function getGoogleAccessToken(scopes: string[], impersonateEmail?: string): Promise<string> {
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
    sub: impersonateEmail ?? adminEmail,
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
    throw new Error(`Google token exchange failed for ${impersonateEmail ?? adminEmail} (${res.status}): ${text}`);
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

// ─── Admin Reports API: find Baker staff who attended ──────────────────

async function findAttendeeViaReports(
  token: string,
  meetingCode: string,
): Promise<{ email: string; items: any[]; _debug: any } | null> {
  const codeVariants = [meetingCode, meetingCode.replace(/-/g, "")];
  const debugInfo: any = { codeVariants, results: [] };

  for (const code of codeVariants) {
    const url = new URL("https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/meet");
    url.searchParams.set("eventName", "call_ended");
    url.searchParams.set("filters", `meeting_code==${code}`);
    url.searchParams.set("maxResults", "200");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json().catch(() => null);
    debugInfo.results.push({
      code,
      status: res.status,
      itemCount: body?.items?.length ?? 0,
      hasItems: !!body?.items,
      error: body?.error ?? null,
    });

    if (!res.ok) continue;

    if (body?.items?.length > 0) {
      const firstEmail = body.items[0]?.actor?.email?.toLowerCase();
      debugInfo.firstEmail = firstEmail;
      return firstEmail ? { email: firstEmail, items: body.items, _debug: debugInfo } : null;
    }
  }
  debugInfo.outcome = "no_items_found";
  return { email: "", items: [], _debug: debugInfo } as any;
}

/** Extract Baker staff from Admin Reports items (the proven old approach) */
function extractInternalFromReports(items: any[]): Map<string, { email: string; displayName: string; durationSec: number; date: string }> {
  const byKey = new Map<string, { email: string; displayName: string; durationSec: number; date: string }>();

  for (const item of items) {
    const email = item.actor?.email?.toLowerCase();
    if (!email) continue;

    const eventTime = item.id?.time ?? item.events?.[0]?.parameters?.find((p: any) => p.name === "start_timestamp")?.value;
    const date = eventTime ? new Date(eventTime).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];

    const params = item.events?.[0]?.parameters ?? [];
    const displayName = params.find((p: any) => p.name === "display_name")?.value ?? "";
    const duration = parseInt(params.find((p: any) => p.name === "duration_seconds")?.intValue ?? "0", 10);

    const key = `${email}|${date}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.durationSec += duration;
      if (!existing.displayName && displayName) existing.displayName = displayName;
    } else {
      byKey.set(key, { email, displayName, durationSec: duration, date });
    }
  }
  return byKey;
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

  const debugLog: any = { steps: [] };

  try {
    // ── Step 1: Admin Reports API to find a known attendee ─────────────
    debugLog.steps.push("getting_reports_token");
    const reportsToken = await getGoogleAccessToken([
      "https://www.googleapis.com/auth/admin.reports.audit.readonly",
    ]);
    debugLog.steps.push("got_reports_token");

    // Inline Reports API call with full debug
    let reportsResult: { email: string; items: any[] } | null = null;
    const reportsDebugInline: any = { codeVariants: [meetingCode, meetingCode.replace(/-/g, "")], attempts: [] };

    for (const code of [meetingCode, meetingCode.replace(/-/g, "")]) {
      const url = new URL("https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/meet");
      url.searchParams.set("eventName", "call_ended");
      url.searchParams.set("filters", `meeting_code==${code}`);
      url.searchParams.set("maxResults", "200");

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${reportsToken}` },
      });

      let body: any = null;
      try { body = await res.json(); } catch {}

      const firstItem = body?.items?.[0];
      reportsDebugInline.attempts.push({
        code,
        status: res.status,
        ok: res.ok,
        itemCount: body?.items?.length ?? 0,
        errorMessage: body?.error?.message ?? null,
        firstActorEmail: firstItem?.actor?.email ?? null,
        firstItemKeys: firstItem ? Object.keys(firstItem) : null,
        firstItemActor: firstItem?.actor ?? null,
        firstItemSample: firstItem ? JSON.stringify(firstItem).slice(0, 500) : null,
      });

      if (res.ok && body?.items?.length > 0) {
        const firstEmail = body.items[0]?.actor?.email?.toLowerCase();
        if (firstEmail) {
          reportsResult = { email: firstEmail, items: body.items };
          break;
        }
      }
    }
    debugLog.reports = reportsDebugInline;

    const internalFromReports = reportsResult
      ? extractInternalFromReports(reportsResult.items)
      : new Map();

    // ── Step 2: Try Meet REST API by impersonating a known attendee ────
    // The Meet API only returns records for meetings the user participated in
    let meetParticipants: MeetParticipant[] = [];
    let conferences: ConferenceRecord[] = [];
    let meetDebug: any = { attempted: false };

    if (reportsResult?.email) {
      try {
        // Impersonate the attendee we found via Admin Reports
        const meetToken = await getGoogleAccessToken(
          ["https://www.googleapis.com/auth/meetings.space.readonly"],
          reportsResult.email,
        );

        // Look up space
        const spaceRes = await fetch(`https://meet.googleapis.com/v2/spaces/${meetingCode}`, {
          headers: { Authorization: `Bearer ${meetToken}` },
        });

        if (spaceRes.ok) {
          const space = await spaceRes.json();
          const spaceName: string = space.name;

          // List conference records
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

          // Fetch participants from all conference records
          if (conferences.length > 0) {
            const allParts = await Promise.all(
              conferences.map((conf) => listParticipants(meetToken, conf.name)),
            );
            meetParticipants = allParts.flat();
          }

          meetDebug = {
            attempted: true,
            impersonated: reportsResult.email,
            spaceName,
            conferencesFound: conferences.length,
            participantsFound: meetParticipants.length,
          };
        } else {
          meetDebug = {
            attempted: true,
            impersonated: reportsResult.email,
            spaceError: spaceRes.status,
          };
        }
      } catch (meetErr) {
        meetDebug = {
          attempted: true,
          impersonated: reportsResult.email,
          error: String(meetErr),
        };
      }
    }

    // ── Step 3: Build participant list ──────────────────────────────────
    // If Meet API worked, use it (has external participants).
    // Always supplement with Admin Reports data for Baker staff.

    const supa = createServiceClient();
    const { data: allApplicants } = await supa
      .from("job_application_parse")
      .select("application_id, candidate_name, email, pipeline_stage")
      .not("email", "is", null);

    const matched: { applicationId: number; name: string; email: string; durationSec: number; stage: string | null; date: string }[] = [];
    const unmatched: { name: string; email: string; durationMin: number; date: string }[] = [];
    const internal: { name: string; email: string; durationMin: number; date: string }[] = [];

    // Track which emails we've already processed (to avoid duplicates)
    const seen = new Set<string>();

    // Process Meet API participants (these include external attendees)
    if (meetParticipants.length > 0) {
      // Resolve emails for signed-in users via Admin Directory
      const adminToken = await getGoogleAccessToken([
        "https://www.googleapis.com/auth/admin.directory.user.readonly",
      ]);

      const signedInUserIds = new Set<string>();
      for (const p of meetParticipants) {
        if (p.signedinUser?.user) signedInUserIds.add(p.signedinUser.user);
      }

      // Batch resolve internal user emails
      const emailMap = new Map<string, string>();
      if (signedInUserIds.size > 0) {
        const results = await Promise.allSettled(
          [...signedInUserIds].map(async (uid) => {
            const numericId = uid.replace("users/", "");
            const res = await fetch(
              `https://admin.googleapis.com/admin/directory/v1/users/${numericId}?projection=basic`,
              { headers: { Authorization: `Bearer ${adminToken}` } },
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
      }

      // Deduplicate Meet participants by (key + conference date)
      const byKey = new Map<string, { displayName: string; email: string; durationSec: number; date: string }>();

      for (let ci = 0; ci < conferences.length; ci++) {
        const conf = conferences[ci];
        const confDate = conf.startTime
          ? new Date(conf.startTime).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        // Find participants that belong to this conference (by index range from flat array)
        // Since we used Promise.all + flat(), we need to track offsets
        // Actually, let's just iterate all meetParticipants and extract date from the participant's own times
      }

      // Simpler approach: use each participant's own join time for the date
      for (const p of meetParticipants) {
        let displayName = "";
        let email = "";

        if (p.signedinUser) {
          displayName = p.signedinUser.displayName ?? "";
          email = emailMap.get(p.signedinUser.user) ?? "";
        } else if (p.anonymousUser) {
          displayName = p.anonymousUser.displayName ?? "Anonymous";
        } else if (p.phoneUser) {
          displayName = p.phoneUser.displayName ?? "Phone User";
        }

        const date = p.earliestStartTime
          ? new Date(p.earliestStartTime).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        let durationSec = 0;
        if (p.earliestStartTime && p.latestEndTime) {
          durationSec = Math.round(
            (new Date(p.latestEndTime).getTime() - new Date(p.earliestStartTime).getTime()) / 1000,
          );
        }

        const key = email
          ? `${email}|${date}`
          : `${normName(displayName)}|${date}`;

        const existing = byKey.get(key);
        if (existing) {
          if (durationSec > existing.durationSec) existing.durationSec = durationSec;
          if (!existing.displayName && displayName) existing.displayName = displayName;
          if (!existing.email && email) existing.email = email;
        } else {
          byKey.set(key, { displayName, email, durationSec, date });
        }
      }

      // Categorize
      for (const p of byKey.values()) {
        const isInternal = p.email &&
          (p.email.endsWith("@baker-aviation.com") || p.email.endsWith("@airninetwo.com"));

        const dedupKey = p.email ? `${p.email}|${p.date}` : `${normName(p.displayName)}|${p.date}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        if (isInternal) {
          internal.push({
            name: p.displayName || p.email.split("@")[0],
            email: p.email,
            durationMin: Math.round(p.durationSec / 60),
            date: p.date,
          });
          continue;
        }

        // Match against applicants by email or name
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
    }

    // Always add Baker staff from Admin Reports (fills gaps if Meet API missed any)
    for (const p of internalFromReports.values()) {
      const dedupKey = `${p.email}|${p.date}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      internal.push({
        name: p.displayName || p.email.split("@")[0],
        email: p.email,
        durationMin: Math.round(p.durationSec / 60),
        date: p.date,
      });
    }

    const totalParticipants = matched.length + unmatched.length + internal.length;

    // ── Step 4: Auto-mark attendance ───────────────────────────────────
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

    // ── Step 5: Save attendance record ─────────────────────────────────
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
        meetApi: meetDebug,
        reportsAttendeeFound: reportsResult?.email ?? null,
        ...debugLog,
      },
    });
  } catch (err) {
    console.error("[attendance] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
