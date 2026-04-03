import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";

/**
 * GET /api/ops/intl/trip-bundle/auto-select?trip_id={intl_trip_id}
 *
 * Resolves which documents should be auto-selected for a trip based on
 * country_document_rules. Returns matched doc IDs per category with reasons.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const tripId = req.nextUrl.searchParams.get("trip_id");
  if (!tripId) return NextResponse.json({ error: "trip_id required" }, { status: 400 });

  const supa = createServiceClient();

  // 1. Get the trip
  const { data: trip } = await supa
    .from("intl_trips")
    .select("id, tail_number, route_icaos, jetinsight_trip_id")
    .eq("id", tripId)
    .single();
  if (!trip) return NextResponse.json({ error: "Trip not found" }, { status: 404 });

  // 2. Resolve route ICAOs to countries
  const { data: countries } = await supa
    .from("countries")
    .select("id, name, iso_code, icao_prefixes");

  const landingCountries: Array<{ id: string; name: string; iso_code: string }> = [];
  const overflightCountries: Array<{ id: string; name: string; iso_code: string }> = [];

  // Landing countries: international airports in the route
  for (const icao of trip.route_icaos) {
    if (!isInternationalIcao(icao)) continue;
    for (const c of countries ?? []) {
      if (c.icao_prefixes?.some((p: string) => icao.startsWith(p))) {
        if (!landingCountries.some((lc) => lc.id === c.id)) {
          landingCountries.push({ id: c.id, name: c.name, iso_code: c.iso_code });
        }
        break;
      }
    }
  }

  // Also check clearances for overflight permits
  const { data: clearances } = await supa
    .from("intl_trip_clearances")
    .select("clearance_type, airport_icao")
    .eq("trip_id", tripId)
    .eq("clearance_type", "overflight_permit");

  for (const cl of clearances ?? []) {
    for (const c of countries ?? []) {
      if (c.icao_prefixes?.some((p: string) => cl.airport_icao.startsWith(p))) {
        if (!overflightCountries.some((oc) => oc.id === c.id) && !landingCountries.some((lc) => lc.id === c.id)) {
          overflightCountries.push({ id: c.id, name: c.name, iso_code: c.iso_code });
        }
        break;
      }
    }
  }

  // 3. Fetch document rules for all relevant countries
  const allCountryIds = [...landingCountries, ...overflightCountries].map((c) => c.id);
  if (allCountryIds.length === 0) {
    return NextResponse.json({ autoSelected: {}, countriesResolved: [] });
  }

  const { data: rules } = await supa
    .from("country_document_rules")
    .select("*")
    .in("country_id", allCountryIds)
    .eq("is_active", true)
    .order("sort_order");

  // Filter rules by applies_to
  const landingIds = new Set(landingCountries.map((c) => c.id));
  const applicableRules = (rules ?? []).filter((r) => {
    if (r.applies_to === "both") return true;
    if (r.applies_to === "landing" && landingIds.has(r.country_id)) return true;
    if (r.applies_to === "overflight" && !landingIds.has(r.country_id)) return true;
    return false;
  });

  // 4. Fetch all available documents to match against
  const [tripDocsRes, aircraftDocsRes, companyDocsRes] = await Promise.all([
    trip.jetinsight_trip_id
      ? supa.from("jetinsight_documents").select("id, category, document_name, entity_type").eq("entity_type", "trip").eq("entity_id", trip.jetinsight_trip_id)
      : Promise.resolve({ data: [] }),
    trip.tail_number
      ? supa.from("jetinsight_documents").select("id, category, document_name, entity_type").eq("entity_type", "aircraft").eq("entity_id", trip.tail_number)
      : Promise.resolve({ data: [] }),
    supa.from("jetinsight_documents").select("id, category, document_name, entity_type").eq("entity_type", "company").eq("entity_id", "baker_aviation"),
  ]);

  // Also get intl_documents (manually uploaded)
  const [intlAircraftRes, intlCompanyRes] = await Promise.all([
    trip.tail_number
      ? supa.from("intl_documents").select("id, name, entity_type").eq("entity_type", "aircraft").eq("entity_id", trip.tail_number).eq("is_current", true)
      : Promise.resolve({ data: [] }),
    supa.from("intl_documents").select("id, name, entity_type").eq("entity_type", "company").eq("entity_id", "baker_aviation").eq("is_current", true),
  ]);

  // Crew docs are per-crew-member, handled separately
  // For "all" crew rules, we just flag that all crew docs should be selected
  const allDocs = [
    ...(tripDocsRes.data ?? []).map((d) => ({ ...d, source: "jetinsight" as const, docCategory: "trip" as const })),
    ...(aircraftDocsRes.data ?? []).map((d) => ({ ...d, source: "jetinsight" as const, docCategory: "aircraft" as const })),
    ...(companyDocsRes.data ?? []).map((d) => ({ ...d, source: "jetinsight" as const, docCategory: "company" as const })),
    ...(intlAircraftRes.data ?? []).map((d) => ({ id: `intl-${d.id}`, category: "", document_name: d.name, entity_type: d.entity_type, source: "intl" as const, docCategory: "aircraft" as const })),
    ...(intlCompanyRes.data ?? []).map((d) => ({ id: `intl-${d.id}`, category: "", document_name: d.name, entity_type: d.entity_type, source: "intl" as const, docCategory: "company" as const })),
  ];

  // 5. Match rules against documents
  const autoSelected: Record<string, Array<{ doc_id: string | number; document_name: string; reason: string; country: string; is_required: boolean }>> = {
    trip: [],
    crew: [],
    aircraft: [],
    company: [],
  };

  const countryNameMap = new Map([...landingCountries, ...overflightCountries].map((c) => [c.id, c.iso_code]));

  for (const rule of applicableRules) {
    const countryCode = countryNameMap.get(rule.country_id) ?? "??";
    const categoryDocs = allDocs.filter((d) => d.docCategory === rule.doc_category);

    if (rule.match_type === "all") {
      // Select all docs in this category
      for (const doc of categoryDocs) {
        autoSelected[rule.doc_category].push({
          doc_id: doc.id,
          document_name: doc.document_name,
          reason: rule.notes || `Required for ${countryCode}`,
          country: countryCode,
          is_required: rule.is_required,
        });
      }
      // For crew, flag that all crew docs should be selected
      if (rule.doc_category === "crew") {
        autoSelected.crew.push({
          doc_id: "__all_crew__",
          document_name: "All crew documents",
          reason: rule.notes || `All crew docs required for ${countryCode}`,
          country: countryCode,
          is_required: rule.is_required,
        });
      }
    } else if (rule.match_type === "exact_name") {
      // Match against document_name OR category
      const match = categoryDocs.find((d) => d.document_name === rule.match_value || d.category === rule.match_value);
      if (match) {
        autoSelected[rule.doc_category].push({
          doc_id: match.id,
          document_name: match.document_name,
          reason: rule.notes || `Required for ${countryCode}`,
          country: countryCode,
          is_required: rule.is_required,
        });
      }
    } else if (rule.match_type === "name_contains" && rule.match_value) {
      // Match against document_name OR category (case-insensitive)
      const needle = rule.match_value.toLowerCase();
      const matches = categoryDocs.filter((d) =>
        d.document_name.toLowerCase().includes(needle) ||
        d.category.toLowerCase().includes(needle)
      );
      for (const match of matches) {
        autoSelected[rule.doc_category].push({
          doc_id: match.id,
          document_name: match.document_name,
          reason: rule.notes || `Required for ${countryCode}`,
          country: countryCode,
          is_required: rule.is_required,
        });
      }
    }
  }

  // Dedupe by doc_id within each category
  for (const cat of Object.keys(autoSelected)) {
    const seen = new Set<string | number>();
    autoSelected[cat] = autoSelected[cat].filter((d) => {
      if (seen.has(d.doc_id)) return false;
      seen.add(d.doc_id);
      return true;
    });
  }

  return NextResponse.json({
    autoSelected,
    countriesResolved: [
      ...landingCountries.map((c) => ({ ...c, type: "landing" })),
      ...overflightCountries.map((c) => ({ ...c, type: "overflight" })),
    ],
  });
}
