import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { isLoginRedirect } from "./parser";
import { postSlackMessage } from "@/lib/slack";

const BASE_URL = "https://portal.jetinsight.com";
const CHARLIE_SLACK_ID = "D0AK75CPPJM";

export interface PostFlightSyncResult {
  inserted: number;
  skipped: number;
  pages: number;
  errors: string[];
  sessionExpired: boolean;
}

/**
 * Pull post-flight data from JetInsight's logged flights JSON endpoint.
 * Replaces the manual CSV upload workflow.
 * Paginates through all results and upserts to post_flight_data.
 */
export async function syncPostFlightData(
  months: number = 3,
  daysBack?: number,
): Promise<PostFlightSyncResult> {
  const result: PostFlightSyncResult = {
    inserted: 0,
    skipped: 0,
    pages: 0,
    errors: [],
    sessionExpired: false,
  };

  const supa = createServiceClient();

  // Get session cookie
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    result.errors.push("No session cookie configured");
    return result;
  }

  // Calculate date range — use MM/DD/YYYY format for search_startdate/search_enddate
  // (the date_start/date_end params return paginated oldest-first and miss recent data)
  const endDate = new Date();
  const startDate = new Date();
  if (daysBack != null) {
    startDate.setDate(startDate.getDate() - daysBack);
  } else {
    startDate.setMonth(startDate.getMonth() - months);
  }
  const fmtDate = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  const startStr = fmtDate(startDate);
  const endStr = fmtDate(endDate);

  // Paginate through all logged flights
  let url: string | null =
    `${BASE_URL}/analytics/logged_flights?search_startdate=${startStr}&search_enddate=${endStr}&search_aircraft=all_active`;

  while (url) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      if (isLoginRedirect(text)) {
        result.sessionExpired = true;
        await postSlackMessage({
          channel: CHARLIE_SLACK_ID,
          text: ":warning: *JetInsight session expired*\n\nThe post-flight sync cookie has expired. Tap below to update it:\n\n:point_right: <https://www.whitelabel-ops.com/jetinsight|Update Cookie on Whiteboard>",
        });
        return result;
      }

      const data = JSON.parse(text);
      const records = data.data ?? [];
      result.pages++;

      // Process each record
      for (const r of records) {
        if (r.record_type !== "FLIGHT ACTUAL") continue;

        const tail = r.reg ?? r.display_reg;
        if (!tail) continue;

        // Normalize aircraft type
        let aircraftType: string | null = null;
        const rawType = r.aircraft_type ?? "";
        if (rawType.includes("Citation")) aircraftType = "CE-750";
        else if (rawType.includes("Challenger")) aircraftType = "CL-30";

        // Parse date
        const dateStr = r.depart_date?.split("T")[0];
        if (!dateStr) continue;

        const origin = r.origin ?? "";
        const destination = r.destination ?? "";

        // Upsert to post_flight_data
        const row = {
          tail_number: tail,
          aircraft_type: aircraftType ?? rawType,
          origin: origin.length === 3 ? `K${origin}` : origin,
          destination: destination.length === 3 ? `K${destination}` : destination,
          flight_date: dateStr,
          segment_number: r.segment_num ?? 1,
          flight_hrs: r.flight_hours ?? null,
          block_hrs: r.block_hours ?? null,
          fuel_start_lbs: r.fuel_out ?? null, // fuel_out = fuel at start (confusing naming)
          fuel_end_lbs: r.fuel_in ?? null, // fuel_in = fuel at end
          fuel_burn_lbs: r.fuel_lbs ?? null,
          fuel_burn_lbs_hour: r.fuel_lbs_per_hour ?? null,
          takeoff_wt_lbs: r.take_off_weight ?? null,
          pax: r.pax ?? null,
          nautical_miles: r.dist_nmiles ?? null,
          gals_pre: r.gals_pre ?? null,
          gals_post: r.gals_post ?? null,
          pic: r.pic ?? null,
          sic: r.sic ?? null,
          trip_id: r.pnr ?? null,
          upload_batch: `jetinsight-auto-${endStr}`,
        };

        try {
          const { error } = await supa.from("post_flight_data").upsert(row, {
            onConflict: "tail_number,origin,destination,flight_date,segment_number",
          });

          if (error) {
            if (!error.message.includes("duplicate")) {
              result.errors.push(`${tail} ${origin}-${destination} ${dateStr}: ${error.message}`);
            } else {
              result.skipped++;
            }
          } else {
            result.inserted++;
          }
        } catch (err) {
          result.errors.push(
            `${tail}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Get next page URL
      url = data.next ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Page fetch: ${msg}`);
      break;
    }
  }

  // Log sync run
  await supa.from("jetinsight_sync_runs").insert({
    sync_type: "post_flight",
    status: result.errors.length > 0 ? "partial" : "ok",
    docs_downloaded: result.inserted,
    docs_skipped: result.skipped,
    errors: result.errors.map((e) => ({ entity: "post_flight", message: e })),
    completed_at: new Date().toISOString(),
  });

  return result;
}
