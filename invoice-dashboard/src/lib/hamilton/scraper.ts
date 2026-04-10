import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";
import type {
  HamiltonTrip,
  HamiltonApiWrapper,
  HamiltonOperatorTripsResponse,
  DeclineSyncResult,
  DeclineSummaryByAgent,
} from "./types";

const BASE_URL = "https://app.hamilton.ai";
const PAGE_SIZE = 200;
const DELAY_MS = 500;
const CHARLIE_SLACK_ID = "D0AK75CPPJM";

// All Baker Aviation pipeline IDs in Hamilton
const PIPELINE_IDS = [
  "9b6571d6-bfd3-416d-8b7c-bc7648c4bc87",
  "bc0deb33-c91e-4050-b9a7-9cad568cd72c",
  "677d7f3b-f963-4c9d-b008-d78d8e33097f",
  "20af614d-a2a6-49a6-80a9-ebf2dfca9769",
  "63c53c21-989a-49b6-87d4-f18f63083581",
  "d0391d07-0331-4b98-9ab3-eeaa209e2956",
  "c0f94072-fe50-45af-b617-04abd5d104a9",
  "e1fb75b3-f9b9-4047-834f-5b185393a6a7",
  "ca6374ac-4200-4108-8f29-a06c8255a61f",
  "fda854a2-c0e9-49ea-9be2-9e3d95c119a9",
  "05ecabe6-5f1f-4ad6-b38f-a71f724050f6",
  "bcdcb687-e0c2-44a3-bcd1-4d4ff94a2ad9",
  "821001eb-2157-454b-8c72-21f14d20399e",
  "1af04368-deff-4624-af7a-5435c86edb3b",
  "8eb0b1b3-8b4b-4caa-bb41-49b44b2e0e09",
  "36f7dc6c-a2e6-4257-9c86-77de065e8a47",
  "75b8a9ce-20c7-4372-94d8-86655eeb78b1",
  "c53ed2ee-4de9-4cab-9c0a-03474db7d776",
  "1d79512d-94a8-4979-bb85-a050a963dde8",
  "14400eea-51ac-4bf4-82f4-8e1842f3ecce",
  "f12a844a-ed7d-4103-aa70-e139f9f2b8be",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Cookie management
// ---------------------------------------------------------------------------

async function getSessionCookie(): Promise<string | null> {
  const supa = createServiceClient();
  const { data } = await supa
    .from("hamilton_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();
  return data?.config_value ?? null;
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function fetchApi(
  path: string,
  cookie: string,
): Promise<HamiltonOperatorTripsResponse> {
  const url = `${BASE_URL}${path}`;
  console.log(`[hamilton] Fetching: ${url.substring(0, 120)}...`);
  const start = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: `wos-session=${cookie}`,
      Accept: "*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
      Referer: `${BASE_URL}/sales/leads`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  console.log(`[hamilton] Response: ${res.status} in ${Date.now() - start}ms`);

  // Hamilton clears the wos-session cookie and returns 302 when session expires
  if (res.status === 302) {
    throw new Error("SESSION_EXPIRED");
  }
  if (!res.ok) {
    throw new Error(
      `Hamilton API error: ${res.status} ${res.statusText} for ${path}`,
    );
  }

  const json = await res.json();
  // Hamilton wraps responses: { type, data, init }
  const data: HamiltonOperatorTripsResponse =
    json.data?.operatorTrips ? json.data : json;
  return data;
}

// ---------------------------------------------------------------------------
// Build URL
// ---------------------------------------------------------------------------

function buildDeclineUrl(
  pageIndex: number,
  departureDateFrom?: string,
): string {
  const pipelineParams = PIPELINE_IDS.map(
    (id) => `pipelineIds=${id}`,
  ).join("&");
  let url = `/api/operator-trips?pageSize=${PAGE_SIZE}&sortColumn=updatedAt&sortOrder=desc&stage=CANCELLED&${pipelineParams}&pageIndex=${pageIndex}`;
  if (departureDateFrom) {
    url += `&departureDateFrom=${departureDateFrom}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Fetch all declined trips
// ---------------------------------------------------------------------------

export async function fetchDeclinedTrips(
  departureDateFrom?: string,
  maxPages: number = 1,
): Promise<{ trips: HamiltonTrip[]; total: number; sessionExpired: boolean }> {
  const cookie = await getSessionCookie();
  if (!cookie) {
    return { trips: [], total: 0, sessionExpired: true };
  }

  const allTrips: HamiltonTrip[] = [];
  let page = 0;
  let total = Infinity;

  try {
    while (allTrips.length < total) {
      if (maxPages && page >= maxPages) break;

      const data = await fetchApi(
        buildDeclineUrl(page, departureDateFrom),
        cookie,
      );
      total = data.operatorTrips.totalRows;
      allTrips.push(...data.operatorTrips.trips);
      console.log(
        `[hamilton] Page ${page}: ${allTrips.length}/${total} declined trips`,
      );
      page++;

      if (allTrips.length < total) {
        await sleep(DELAY_MS);
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "SESSION_EXPIRED") {
      await postSlackMessage({
        channel: CHARLIE_SLACK_ID,
        text: "🔑 Hamilton session expired — update the cookie in the dashboard settings.",
      });
      return { trips: allTrips, total, sessionExpired: true };
    }
    throw err;
  }

  return { trips: allTrips, total, sessionExpired: false };
}

// ---------------------------------------------------------------------------
// Sync declined trips to Supabase
// ---------------------------------------------------------------------------

export async function syncDeclines(
  departureDateFrom?: string,
): Promise<DeclineSyncResult> {
  const result: DeclineSyncResult = {
    totalDeclines: 0,
    tripsUpserted: 0,
    agentSummary: [],
    errors: [],
    sessionExpired: false,
  };

  const { trips, total, sessionExpired } =
    await fetchDeclinedTrips(departureDateFrom);

  result.totalDeclines = total;
  result.sessionExpired = sessionExpired;

  if (sessionExpired && trips.length === 0) {
    result.errors.push("Session expired — no data fetched");
    return result;
  }

  const supa = createServiceClient();

  // Upsert trips in batches of 100
  const BATCH = 100;
  for (let i = 0; i < trips.length; i += BATCH) {
    const batch = trips.slice(i, i + BATCH).map((t) => ({
      hamilton_trip_id: t.id,
      display_code: t.displayCode,
      operator_status: t.operatorStatus,
      sales_agent_id: t.salesAgentId,
      auto_quoted: t.autoQuoted,
      lowest_price: t.lowestPrice,
      contact_name: t.contact
        ? `${t.contact.firstName} ${t.contact.lastName}`.trim()
        : null,
      contact_email: t.contact?.email ?? null,
      contact_company: t.contactCompany?.title ?? null,
      departure_airport: t.legs?.[0]?.departureAirportIcao ?? null,
      arrival_airport: t.legs?.[0]?.arrivalAirportIcao ?? null,
      departure_date: t.legs?.[0]?.departureDatetime ?? null,
      pax: t.legs?.[0]?.pax ?? null,
      aircraft_category:
        t.legs?.[0]?.minAircraftCategory?.displayName ?? null,
      leg_count: t.legs?.length ?? 0,
      pipeline_id: t.pipelineId,
      hamilton_created_at: t.createdAt,
      hamilton_updated_at: t.updatedAt,
    }));

    const { error } = await supa
      .from("hamilton_declined_trips")
      .upsert(batch, { onConflict: "hamilton_trip_id" });

    if (error) {
      console.error("[hamilton] upsert error:", error);
      result.errors.push(`Upsert batch ${i}: ${error.message}`);
    } else {
      result.tripsUpserted += batch.length;
    }
  }

  // Build agent summary from synced data
  const agentMap: Record<string, { count: number; totalValue: number }> = {};
  for (const t of trips) {
    const id = t.salesAgentId;
    if (!agentMap[id]) agentMap[id] = { count: 0, totalValue: 0 };
    agentMap[id].count++;
    agentMap[id].totalValue += t.lowestPrice ?? 0;
  }

  // Get agent name mappings
  const { data: agentRows } = await supa
    .from("hamilton_sales_agents")
    .select("agent_id, agent_name");

  const nameMap: Record<string, string> = {};
  for (const row of agentRows ?? []) {
    nameMap[row.agent_id] = row.agent_name;
  }

  result.agentSummary = Object.entries(agentMap)
    .map(([id, stats]) => ({
      salesAgentId: id,
      salesAgentName: nameMap[id] ?? null,
      ...stats,
    }))
    .sort((a, b) => b.count - a.count);

  return result;
}
