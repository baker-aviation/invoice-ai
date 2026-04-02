import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/ops/intl/trip-bundle?trip_id={intl_trip_id}
 *
 * Returns all linked data for an international trip:
 * - Crew (PIC/SIC per leg from flights table)
 * - Crew compliance docs (from jetinsight_documents)
 * - Aircraft docs (from jetinsight_documents)
 * - Trip docs (GenDec, manifests from jetinsight_documents)
 * - Company docs (from jetinsight_documents)
 * - Passenger names (from jetinsight_trip_passengers)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const tripId = req.nextUrl.searchParams.get("trip_id");
  if (!tripId) {
    return NextResponse.json({ error: "trip_id required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Get the intl trip
  const { data: trip } = await supa
    .from("intl_trips")
    .select("id, tail_number, route_icaos, flight_ids, jetinsight_trip_id")
    .eq("id", tripId)
    .single();

  if (!trip) {
    return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  }

  // 1. Get crew per leg from flights table
  const flightIds = trip.flight_ids ?? [];
  let legs: Array<{
    dep: string;
    arr: string;
    pic: string | null;
    sic: string | null;
    departure: string | null;
  }> = [];

  if (flightIds.length > 0) {
    const { data: flights } = await supa
      .from("flights")
      .select("id, departure_icao, arrival_icao, pic, sic, scheduled_departure")
      .in("id", flightIds);

    // Order by flight_ids position
    const flightMap = new Map((flights ?? []).map((f) => [f.id, f]));
    legs = flightIds.map((fid: string) => {
      const f = flightMap.get(fid);
      return {
        dep: f?.departure_icao ?? "?",
        arr: f?.arrival_icao ?? "?",
        pic: f?.pic ?? null,
        sic: f?.sic ?? null,
        departure: f?.scheduled_departure ?? null,
      };
    });
  }

  // Collect unique crew names
  const crewNames = new Set<string>();
  for (const leg of legs) {
    if (leg.pic) crewNames.add(leg.pic);
    if (leg.sic) crewNames.add(leg.sic);
  }

  // 2. Get crew compliance docs
  // Match crew names to pilot_profiles to get their JI entity_id
  const crewDocs: Record<
    string,
    Array<{ id: number; category: string; document_name: string; signed_url: string | null }>
  > = {};

  if (crewNames.size > 0) {
    const { data: profiles } = await supa
      .from("pilot_profiles")
      .select("id, full_name, jetinsight_uuid")
      .in("full_name", [...crewNames]);

    for (const profile of profiles ?? []) {
      // Try both profile ID and JI UUID as entity_id
      const entityIds = [String(profile.id)];
      if (profile.jetinsight_uuid) entityIds.push(profile.jetinsight_uuid);

      const { data: docs } = await supa
        .from("jetinsight_documents")
        .select("id, category, document_name, gcs_bucket, gcs_key")
        .eq("entity_type", "crew")
        .in("entity_id", entityIds)
        .order("category");

      if (docs && docs.length > 0) {
        const signed = await Promise.all(
          docs.map(async (d) => ({
            id: d.id,
            category: d.category,
            document_name: d.document_name,
            signed_url: await signGcsUrl(d.gcs_bucket, d.gcs_key, 60),
          })),
        );
        crewDocs[profile.full_name] = signed;
      }
    }
  }

  // 3. Aircraft docs
  let aircraftDocs: Array<{
    id: number;
    category: string;
    document_name: string;
    signed_url: string | null;
  }> = [];

  if (trip.tail_number) {
    const { data: acDocs } = await supa
      .from("jetinsight_documents")
      .select("id, category, document_name, gcs_bucket, gcs_key")
      .eq("entity_type", "aircraft")
      .eq("entity_id", trip.tail_number)
      .order("category");

    if (acDocs) {
      aircraftDocs = await Promise.all(
        acDocs.map(async (d) => ({
          id: d.id,
          category: d.category,
          document_name: d.document_name,
          signed_url: await signGcsUrl(d.gcs_bucket, d.gcs_key, 60),
        })),
      );
    }
  }

  // 4. Trip docs (GenDec, manifests, etc.)
  let tripDocs: Array<{
    id: number;
    category: string;
    document_name: string;
    signed_url: string | null;
  }> = [];

  if (trip.jetinsight_trip_id) {
    const { data: tDocs } = await supa
      .from("jetinsight_documents")
      .select("id, category, document_name, gcs_bucket, gcs_key")
      .eq("entity_type", "trip")
      .eq("entity_id", trip.jetinsight_trip_id)
      .order("category");

    if (tDocs) {
      tripDocs = await Promise.all(
        tDocs.map(async (d) => ({
          id: d.id,
          category: d.category,
          document_name: d.document_name,
          signed_url: await signGcsUrl(d.gcs_bucket, d.gcs_key, 60),
        })),
      );
    }
  }

  // 5. Company docs
  const { data: coDocs } = await supa
    .from("jetinsight_documents")
    .select("id, category, document_name, gcs_bucket, gcs_key")
    .eq("entity_type", "company")
    .eq("entity_id", "baker_aviation")
    .order("category");

  const companyDocs = await Promise.all(
    (coDocs ?? []).map(async (d) => ({
      id: d.id,
      category: d.category,
      document_name: d.document_name,
      signed_url: await signGcsUrl(d.gcs_bucket, d.gcs_key, 60),
    })),
  );

  // 6. Passenger names
  let passengers: string[] = [];
  if (trip.jetinsight_trip_id) {
    const { data: pax } = await supa
      .from("jetinsight_trip_passengers")
      .select("passenger_name")
      .eq("jetinsight_trip_id", trip.jetinsight_trip_id)
      .order("passenger_name");
    passengers = (pax ?? []).map((p) => p.passenger_name);
  }

  return NextResponse.json({
    legs,
    crewDocs,
    aircraftDocs,
    tripDocs,
    companyDocs,
    passengers,
  });
}
