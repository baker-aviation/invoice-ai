import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";
import { signGcsUrl } from "@/lib/gcs";
import { healOrphanedFlightIds } from "@/lib/intlTripHeal";

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

  // Auto-heal orphaned flight_ids before loading crew/docs
  await healOrphanedFlightIds(supa, [trip]);

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
    // Fetch ALL profiles and do flexible matching (exact, last name, partial)
    const { data: allProfiles } = await supa
      .from("pilot_profiles")
      .select("id, full_name, jetinsight_uuid");

    const profiles = [];
    const matchedNames = new Map<string, string>(); // crewName → profile.full_name

    for (const crewName of crewNames) {
      const nameLower = crewName.toLowerCase().trim();
      const lastNameParts = nameLower.split(/\s+/);
      const lastName = lastNameParts[lastNameParts.length - 1];
      const firstName = lastNameParts[0];

      let match = (allProfiles ?? []).find(
        (p) => p.full_name?.toLowerCase().trim() === nameLower,
      );

      // Try without middle initial: "Frederick A Gilman" → "Frederick Gilman"
      if (!match) {
        const noMiddle = lastNameParts.filter((_, i) => i === 0 || i === lastNameParts.length - 1).join(" ");
        match = (allProfiles ?? []).find(
          (p) => p.full_name?.toLowerCase().trim() === noMiddle,
        );
      }

      // Try first + last name match (handles middle names: "Todd Ratzlaff" → "Todd McKillip Ratzlaff")
      if (!match && lastNameParts.length >= 2) {
        match = (allProfiles ?? []).find((p) => {
          const pParts = p.full_name?.toLowerCase().trim().split(/\s+/) ?? [];
          return pParts[0] === firstName && pParts[pParts.length - 1] === lastName;
        });
      }

      // Try nickname/short form: "Andrew" → "Andy", "Chris" → "Christopher"
      if (!match && lastNameParts.length >= 2) {
        match = (allProfiles ?? []).find((p) => {
          const pParts = p.full_name?.toLowerCase().trim().split(/\s+/) ?? [];
          const pLast = pParts[pParts.length - 1];
          const pFirst = pParts[0];
          if (pLast !== lastName) return false;
          // Check if first name starts with the same 3+ chars (Andy/Andrew, Chris/Christopher)
          return pFirst.startsWith(firstName.slice(0, 3)) || firstName.startsWith(pFirst.slice(0, 3));
        });
      }

      // Last resort: last name only (if unique match)
      if (!match && lastName.length >= 3) {
        const lastNameMatches = (allProfiles ?? []).filter((p) => {
          const pParts = p.full_name?.toLowerCase().trim().split(/\s+/) ?? [];
          return pParts[pParts.length - 1] === lastName;
        });
        if (lastNameMatches.length === 1) match = lastNameMatches[0];
      }

      if (match) {
        profiles.push(match);
        matchedNames.set(crewName, match.full_name);
      }
    }

    for (const profile of profiles) {
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
        // Use the crew name from the flight (matches what's shown in "Crew by Leg")
        const displayName = [...matchedNames.entries()].find(
          ([, pName]) => pName === profile.full_name,
        )?.[0] ?? profile.full_name;
        crewDocs[displayName] = signed;
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

  // 5. Company docs — filtered by admin selection (app_settings.intl_company_doc_ids)
  let companyDocFilter: number[] | null = null;
  try {
    const { data: setting } = await supa
      .from("app_settings")
      .select("value")
      .eq("key", "intl_company_doc_ids")
      .maybeSingle();
    if (setting?.value) {
      companyDocFilter = JSON.parse(setting.value) as number[];
    }
  } catch { /* no filter = show all */ }

  let coQuery = supa
    .from("jetinsight_documents")
    .select("id, category, document_name, gcs_bucket, gcs_key")
    .eq("entity_type", "company")
    .eq("entity_id", "baker_aviation")
    .order("category");

  if (companyDocFilter && companyDocFilter.length > 0) {
    coQuery = coQuery.in("id", companyDocFilter);
  }

  const { data: coDocs } = await coQuery;

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
