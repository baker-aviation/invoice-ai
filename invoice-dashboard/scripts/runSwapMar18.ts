#!/usr/bin/env npx tsx
/**
 * Standalone Crew Swap Pipeline — March 18, 2026
 *
 * Runs: computeAllRoutes → getRoutesForOptimizer → assignOncomingCrew → buildSwapPlan
 * Outputs Excel to public/Charlies Examples/Mar18_optimizer_output.xlsx
 */

import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { computeAllRoutes, getRoutesForOptimizer } from "../src/lib/pilotRoutes";
import {
  buildSwapPlan,
  assignOncomingCrew,
  type CrewMember,
  type FlightLeg,
  type SwapAssignment,
  type AirportAlias,
  type OncomingPool,
  type OncomingPoolEntry,
  type CrewSwapRow,
} from "../src/lib/swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "../src/lib/airportAliases";

// ─── Config ───────────────────────────────────────────────────────────────────
const SWAP_DATE = "2026-03-18";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars");
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ─── Excluded crew ────────────────────────────────────────────────────────────
const EXCLUDED_NAMES = [
  "Will Hecox",     // OFF March 18-21
  "Ken Ruth",       // OFF March 18-20
  "Bob Oliver",     // Training March 18-19
  "Brad Weaver",    // STANDBY ONLY — DO NOT FLY
];
// Note: Juan Velasquez training Mar 23-27 but available for swap day — keep him

// Choate stays on N106PC
const STAYING_CREW = [
  { name: "Ben Choate", tail: "N106PC", role: "PIC" as const },
];

// ─── Volunteer flags from docx ────────────────────────────────────────────────
type VolFlag = { early: boolean; late: boolean; standby: boolean };
const VOLUNTEERS: Record<string, VolFlag> = {
  "Joshua Raymond":       { early: true, late: false, standby: false },
  "Sebastian Rodriguez":  { early: false, late: true, standby: false },
  "Todd Ratzlaff":        { early: false, late: true, standby: false },
  "Rob Whittin":          { early: true, late: false, standby: false },
  "James Latshaw":        { early: true, late: false, standby: false }, // "Tuesday" = early
  "Ryan Lofswold":        { early: false, late: true, standby: false },
  "Canton Phillips":      { early: true, late: false, standby: false },
  "Jon Stack":            { early: true, late: false, standby: false },
  "Kevin Scott":          { early: true, late: false, standby: false },
  "Eric Gordy":           { early: false, late: true, standby: false },
  "Michael Hutka":        { early: false, late: true, standby: false },
  "Eric Tallberg":        { early: false, late: true, standby: false },
  "Mark Lang":            { early: true, late: false, standby: false },
  "Juan Ruiz":            { early: false, late: false, standby: true },
  "Fernand Muffoletto":   { early: true, late: false, standby: false },
  "Gregory Dworek":       { early: false, late: false, standby: true },
  "Patrick McLoughlin":   { early: true, late: false, standby: false },
  "Matt Hill":            { early: true, late: false, standby: false },
  "Joseph Champion":      { early: false, late: true, standby: false },
  "Travis Farewell":      { early: true, late: true, standby: false },
  "Robert Lankford":      { early: false, late: true, standby: false },
  "Alexander Bengoechea": { early: true, late: false, standby: false },
  "Fred Fields":          { early: false, late: false, standby: true },
  "Elizabeth Leus":       { early: true, late: false, standby: false },
  "Matt Kim":             { early: false, late: true, standby: false },
  "Aaron Fry":            { early: false, late: false, standby: true },
  "Sean Brammer-Hogan":   { early: false, late: true, standby: false },
  "Chris Wood":           { early: true, late: false, standby: false },
  "John Buerschen":       { early: true, late: false, standby: false },
  "Scott Leach":          { early: true, late: false, standby: false },
  "Edward Ley":           { early: true, late: false, standby: false },
  "Zack Benz":            { early: false, late: true, standby: false },
  "Daniel Dusold":        { early: false, late: true, standby: false },
  "Mark Smith":           { early: false, late: false, standby: true },
  "Alfredo Cruz":         { early: true, late: true, standby: false },
  "Jon Spencer":          { early: false, late: false, standby: true },
  "Nick Seeberger":       { early: false, late: true, standby: false },
  "Tony Frandino":        { early: false, late: true, standby: false },
  "David Cerise":         { early: true, late: false, standby: false },
  "Christopher Unger":    { early: false, late: false, standby: true },
  "Lionel Macklin":       { early: false, late: true, standby: false },
  "Jordan Thomas":        { early: false, late: true, standby: false },
};

// ─── Parse Excel for oncoming/offgoing pools ─────────────────────────────────

function parseNameAndHome(raw: string): { name: string; homes: string[] } {
  // "🟢 Aaron Fry (PHX)" → { name: "Aaron Fry", homes: ["PHX"] }
  // "🟡 Alex Krichevsky (HPN / EWR)" → { name: "Alex Krichevsky", homes: ["HPN", "EWR"] }
  // "🟣 Ben Choate (COS/DEN)   ✔" → { name: "Ben Choate", homes: ["COS", "DEN"] }
  let clean = raw.replace(/[🟢🟡🟣⚪️]/g, "").replace(/✔/g, "").trim();
  const homeMatch = clean.match(/\(([^)]+)\)/);
  let homes: string[] = [];
  if (homeMatch) {
    homes = homeMatch[1].split(/[/,]/).map(h => h.trim()).filter(Boolean)
      // Remove non-airport tokens like "N.Y.C."
      .filter(h => /^[A-Z]{3}$/.test(h));
    clean = clean.replace(/\([^)]+\)/, "").trim();
  }
  return { name: clean, homes };
}

function getAircraftType(emoji: string): string {
  if (emoji.includes("🟢")) return "citation_x";
  if (emoji.includes("🟡")) return "challenger";
  if (emoji.includes("🟣")) return "dual"; // flies both
  return "unknown";
}

function applyVolunteerFlags(entry: OncomingPoolEntry): OncomingPoolEntry {
  // Check exact match first, then try first+last
  const vol = VOLUNTEERS[entry.name];
  if (vol) {
    entry.early_volunteer = vol.early;
    entry.late_volunteer = vol.late;
    entry.standby_volunteer = vol.standby;
  }
  return entry;
}

function parseSwapExcel(): {
  oncomingPool: OncomingPool;
  offgoingAssignments: Record<string, SwapAssignment>;
} {
  const wb = XLSX.readFile("public/Charlies Examples/3_18 swap (updated).xlsx");
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");

  const oncomingPool: OncomingPool = { pic: [], sic: [] };
  const offgoingAssignments: Record<string, SwapAssignment> = {};

  let section: "oncoming_pic" | "oncoming_sic" | "offgoing_pic" | "offgoing_sic" | null = null;

  for (let r = 0; r <= range.e.r; r++) {
    const cellC = ws[XLSX.utils.encode_cell({ r, c: 2 })]?.v?.toString() ?? "";
    const cellD = ws[XLSX.utils.encode_cell({ r, c: 3 })]?.v?.toString() ?? "";
    const cellE = ws[XLSX.utils.encode_cell({ r, c: 4 })]?.v?.toString() ?? "";
    const cellA = ws[XLSX.utils.encode_cell({ r, c: 0 })]?.v?.toString() ?? "";
    const cellK = ws[XLSX.utils.encode_cell({ r, c: 10 })]?.v?.toString() ?? ""; // Notes

    // Section headers
    if (cellC === "ONCOMING PILOTS") { section = null; continue; }
    if (cellC === "OFFGOING PILOTS") { section = null; continue; }
    if (cellC === "PILOT IN-COMMAND" && section === null) {
      // Check previous rows to figure out if oncoming or offgoing
      const prevRows: string[] = [];
      for (let pr = Math.max(0, r - 5); pr < r; pr++) {
        const v = ws[XLSX.utils.encode_cell({ r: pr, c: 2 })]?.v?.toString() ?? "";
        prevRows.push(v);
      }
      if (prevRows.some(p => p.includes("OFFGOING"))) section = "offgoing_pic";
      else section = "oncoming_pic";
      continue;
    }
    if (cellC === "SECOND IN-COMMAND") {
      if (section === "oncoming_pic") section = "oncoming_sic";
      else if (section === "offgoing_pic") section = "offgoing_sic";
      continue;
    }
    if (cellC === "Name (Home Base)") continue; // header row

    // Skip empty rows
    if (!cellC || !cellC.match(/[🟢🟡🟣]/)) continue;

    const { name, homes } = parseNameAndHome(cellC);
    const acType = getAircraftType(cellC);
    const isSkillbridge = cellA === "true" || cellA === "TRUE";

    // Skip excluded crew
    if (EXCLUDED_NAMES.some(ex => name.toLowerCase().includes(ex.toLowerCase()))) continue;
    // Skip Choate from oncoming (he stays)
    if (name === "Ben Choate" && (section === "oncoming_pic" || section === "oncoming_sic")) continue;

    if (section === "oncoming_pic" || section === "oncoming_sic") {
      const entry: OncomingPoolEntry = {
        name,
        aircraft_type: acType,
        home_airports: homes,
        is_checkairman: cellC.includes("✔"),
        is_skillbridge: isSkillbridge,
        early_volunteer: false,
        late_volunteer: false,
        standby_volunteer: false,
        notes: cellK || null,
      };
      applyVolunteerFlags(entry);

      if (section === "oncoming_pic") oncomingPool.pic.push(entry);
      else oncomingPool.sic.push(entry);
    } else if (section === "offgoing_pic" || section === "offgoing_sic") {
      const tail = cellE.trim(); // Aircraft column
      if (!tail) continue;

      if (!offgoingAssignments[tail]) {
        offgoingAssignments[tail] = {
          oncoming_pic: null,
          oncoming_sic: null,
          offgoing_pic: null,
          offgoing_sic: null,
        };
      }
      if (section === "offgoing_pic") offgoingAssignments[tail].offgoing_pic = name;
      else offgoingAssignments[tail].offgoing_sic = name;
    }
  }

  return { oncomingPool, offgoingAssignments };
}

// ─── Derive offgoing from JetInsight: Tuesday crews + Wednesday legs ─────────
// Tuesday's crew = who is PIC/SIC on each tail (the offgoing crew)
// Wednesday's legs = where the aircraft will be (swap points)
function deriveOffgoingFromFlights(
  flights: FlightLeg[],
  swapDate: string,
  excelOffgoing: Record<string, SwapAssignment>,
): Record<string, SwapAssignment> {
  const result: Record<string, SwapAssignment> = {};

  // Compute Tuesday (day before swap)
  const swapD = new Date(swapDate + "T00:00:00Z");
  const tuesdayD = new Date(swapD);
  tuesdayD.setUTCDate(tuesdayD.getUTCDate() - 1);
  const tuesdayStr = tuesdayD.toISOString().slice(0, 10); // "2026-03-17"
  const tuesdayStart = `${tuesdayStr}T00:00:00Z`;
  const tuesdayEnd = `${tuesdayStr}T23:59:59Z`;

  console.log(`   Using Tuesday ${tuesdayStr} crews as offgoing`);
  console.log(`   Using Wednesday ${swapDate} legs for swap points`);

  // Group flights by tail
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  // Start with all tails from Excel as baseline
  for (const [tail, assignment] of Object.entries(excelOffgoing)) {
    result[tail] = { ...assignment };
  }

  // For each tail, find last Tuesday flight to get PIC/SIC (offgoing crew)
  for (const [tail, legs] of byTail) {
    const tuesdayLegs = legs
      .filter(l => l.scheduled_departure >= tuesdayStart && l.scheduled_departure <= tuesdayEnd)
      .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));

    if (tuesdayLegs.length === 0) continue;

    // Last Tuesday flight has the crew who was on the aircraft
    const lastTuesday = tuesdayLegs[tuesdayLegs.length - 1];

    if (!result[tail]) {
      result[tail] = { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null };
    }

    // Override with Tuesday's crew (only if JetInsight has them assigned)
    if (lastTuesday.pic) result[tail].offgoing_pic = lastTuesday.pic;
    if (lastTuesday.sic) result[tail].offgoing_sic = lastTuesday.sic;
  }

  return result;
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Crew Swap Pipeline: March 18, 2026 ===\n");

  // 1. Parse Excel for oncoming pool only (offgoing will be re-derived from flights)
  console.log("📋 Parsing swap Excel...");
  const { oncomingPool, offgoingAssignments: excelOffgoing } = parseSwapExcel();
  console.log(`   Oncoming PICs: ${oncomingPool.pic.length}`);
  console.log(`   Oncoming SICs: ${oncomingPool.sic.length}`);
  console.log(`   Excel offgoing tails: ${Object.keys(excelOffgoing).length} (will re-derive from flights)`);
  console.log(`   Staying crew: ${STAYING_CREW.map(c => `${c.name} on ${c.tail}`).join(", ")}`);

  // 2. Load crew roster from Supabase
  console.log("\n👥 Loading crew roster from Supabase...");
  const { data: crewData, error: crewErr } = await supa
    .from("crew_members")
    .select("id, name, role, home_airports, aircraft_types, is_checkairman, checkairman_types, is_skillbridge, grade, restrictions, priority, rotation_group, active")
    .eq("active", true);

  if (crewErr || !crewData) {
    console.error("Failed to load crew:", crewErr?.message);
    process.exit(1);
  }
  const crewRoster: CrewMember[] = crewData.map(c => ({
    id: c.id,
    name: c.name,
    role: c.role,
    home_airports: c.home_airports ?? [],
    aircraft_types: c.aircraft_types ?? [],
    is_checkairman: c.is_checkairman ?? false,
    checkairman_types: c.checkairman_types ?? [],
    is_skillbridge: c.is_skillbridge ?? false,
    grade: c.grade ?? 3,
    restrictions: c.restrictions ?? {},
    priority: c.priority ?? 0,
    standby_count: 0,
    rotation_group: c.rotation_group ?? null,
  }));
  console.log(`   Loaded ${crewRoster.length} active crew members`);

  // 3. Load flights around swap day
  console.log("\n✈️  Loading flights from Supabase...");
  const { data: flightData, error: flightErr } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
    .gte("scheduled_departure", "2026-03-14T00:00:00Z")
    .lte("scheduled_departure", "2026-03-19T23:59:59Z")
    .order("scheduled_departure");

  if (flightErr || !flightData) {
    console.error("Failed to load flights:", flightErr?.message);
    process.exit(1);
  }
  const flights: FlightLeg[] = flightData.map(f => ({
    id: f.id,
    tail_number: f.tail_number,
    departure_icao: f.departure_icao,
    arrival_icao: f.arrival_icao,
    scheduled_departure: f.scheduled_departure,
    scheduled_arrival: f.scheduled_arrival,
    flight_type: f.flight_type,
    pic: f.pic,
    sic: f.sic,
  }));
  console.log(`   Loaded ${flights.length} flights (Mar 14-19)`);
  const wedFlights = flights.filter(f => f.scheduled_departure >= "2026-03-18T00:00:00Z" && f.scheduled_departure < "2026-03-19T00:00:00Z");
  console.log(`   Wednesday Mar 18 flights: ${wedFlights.length}`);

  // 3b. Derive offgoing crew: Tuesday's crew + Wednesday's legs
  console.log("\n🔄 Deriving offgoing crew (Tuesday crews + Wednesday legs)...");
  const offgoingAssignments = deriveOffgoingFromFlights(flights, SWAP_DATE, excelOffgoing);
  const offTails = Object.keys(offgoingAssignments);
  console.log(`   Offgoing tails from flights: ${offTails.length}`);

  // Show differences from Excel
  const excelTails = new Set(Object.keys(excelOffgoing));
  const flightTails = new Set(offTails);
  const newTails = offTails.filter(t => !excelTails.has(t));
  const removedTails = [...excelTails].filter(t => !flightTails.has(t));
  if (newTails.length > 0) console.log(`   New tails (not in Excel): ${newTails.join(", ")}`);
  if (removedTails.length > 0) console.log(`   Removed tails (in Excel, not in flights): ${removedTails.join(", ")}`);

  // Show crew changes
  for (const tail of offTails) {
    const excel = excelOffgoing[tail];
    const flight = offgoingAssignments[tail];
    if (excel) {
      if (excel.offgoing_pic !== flight.offgoing_pic) {
        console.log(`   ${tail} PIC changed: ${excel.offgoing_pic ?? "none"} → ${flight.offgoing_pic ?? "none"}`);
      }
      if (excel.offgoing_sic !== flight.offgoing_sic) {
        console.log(`   ${tail} SIC changed: ${excel.offgoing_sic ?? "none"} → ${flight.offgoing_sic ?? "none"}`);
      }
    }
  }

  // 4. Load airport aliases
  console.log("\n🏢 Loading airport aliases...");
  const { data: aliasData } = await supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred");
  const aliases: AirportAlias[] = (aliasData && aliasData.length > 0)
    ? aliasData.map(a => ({ fbo_icao: a.fbo_icao, commercial_icao: a.commercial_icao, preferred: a.preferred }))
    : DEFAULT_AIRPORT_ALIASES.map(a => ({ fbo_icao: a.fbo_icao, commercial_icao: a.commercial_icao, preferred: a.preferred }));
  console.log(`   ${aliases.length} aliases loaded`);

  // 5. Pre-compute routes (FlightAware + HasData) — SKIP if already computed
  const SKIP_ROUTE_COMPUTE = process.argv.includes("--skip-routes");
  const SKIP_FA = process.argv.includes("--skip-fa");
  if (SKIP_ROUTE_COMPUTE) {
    console.log("\n🔍 Phase 1: SKIPPED (--skip-routes). Using existing pilot_routes data.");
  } else {
    if (SKIP_FA) {
      console.log("\n🔍 Computing routes (HasData only, skipping FlightAware)...");
    } else {
      console.log("\n🔍 Phase 1: Computing all routes (FlightAware + HasData)...");
    }
    console.log("   This will make API calls — may take a few minutes...");
    const routeResult = await computeAllRoutes(SWAP_DATE);
    console.log(`   Crew processed: ${routeResult.crewProcessed}`);
    console.log(`   FlightAware calls: ${routeResult.flightAwareCalls}`);
    console.log(`   HasData calls: ${routeResult.hasDataCalls}`);
    console.log(`   Scheduled flights found: ${routeResult.totalScheduledFlights}`);
    console.log(`   Priced O→D pairs: ${routeResult.pricedPairs}`);
    console.log(`   Total routes saved: ${routeResult.totalRoutes}`);
    if (routeResult.errors.length > 0) {
      console.log(`   ⚠️  Errors: ${routeResult.errors.length}`);
      routeResult.errors.slice(0, 5).forEach(e => console.log(`      ${e}`));
    }
  }

  // 6. Load pre-computed routes for optimizer
  console.log("\n📦 Phase 2: Loading routes for optimizer...");
  const { commercialFlights, routeCount, crewRouteMap, crewOffgoingMap } = await getRoutesForOptimizer(SWAP_DATE);
  console.log(`   Routes loaded: ${routeCount}`);
  console.log(`   Unique flight keys: ${commercialFlights.size}`);
  console.log(`   Crew oncoming route sets: ${crewRouteMap.size}`);
  console.log(`   Crew offgoing route sets: ${crewOffgoingMap.size}`);

  // 7. Assign oncoming crew
  console.log("\n🧩 Phase 3: Assigning oncoming crew (transport-first)...");
  const assignment = assignOncomingCrew({
    swapAssignments: offgoingAssignments,
    oncomingPool,
    crewRoster,
    flights,
    swapDate: SWAP_DATE,
    aliases,
    commercialFlights,
    preComputedRoutes: crewRouteMap,
    preComputedOffgoing: crewOffgoingMap,
  });
  console.log(`   Assigned ${assignment.details.length} crew to tails`);
  console.log(`   Standby PICs: ${assignment.standby.pic.join(", ") || "none"}`);
  console.log(`   Standby SICs: ${assignment.standby.sic.join(", ") || "none"}`);

  // 8. Build full swap plan
  console.log("\n📊 Phase 4: Building swap plan...");
  const plan = buildSwapPlan({
    flights,
    crewRoster,
    aliases,
    swapDate: SWAP_DATE,
    commercialFlights,
    swapAssignments: assignment.assignments,
    oncomingPool,
    stayingCrew: STAYING_CREW,
  });
  console.log(`   Total rows: ${plan.rows.length}`);
  console.log(`   Solved: ${plan.solved_count}`);
  console.log(`   Unsolved: ${plan.unsolved_count}`);
  console.log(`   Total cost: $${plan.total_cost.toLocaleString()}`);
  console.log(`   Plan score: ${plan.plan_score}`);
  if (plan.warnings.length > 0) {
    console.log(`   ⚠️  Warnings (${plan.warnings.length}):`);
    plan.warnings.forEach(w => console.log(`      ${w}`));
  }

  // 9. Export to Excel
  console.log("\n📝 Exporting to Excel...");
  exportToExcel(plan.rows, plan);

  console.log("\n✅ Done! Output: public/Charlies Examples/Mar18_optimizer_output.xlsx");
}

// ─── Excel Export ─────────────────────────────────────────────────────────────

function fmtLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York", // Default; real impl uses swap location tz
  }) + "L";
}

function exportToExcel(rows: CrewSwapRow[], plan: { swap_date: string; warnings: string[] }) {
  const wb = XLSX.utils.book_new();

  // Sort: oncoming first, then offgoing. Within each: PIC then SIC.
  // Within role: Citation X → Challenger → Standby
  const typeOrder = (t: string) => {
    if (t.includes("citation")) return 0;
    if (t.includes("challenger")) return 1;
    return 2;
  };

  const oncomingPic = rows.filter(r => r.direction === "oncoming" && r.role === "PIC")
    .sort((a, b) => typeOrder(a.aircraft_type) - typeOrder(b.aircraft_type) || a.tail_number.localeCompare(b.tail_number));
  const oncomingSic = rows.filter(r => r.direction === "oncoming" && r.role === "SIC")
    .sort((a, b) => typeOrder(a.aircraft_type) - typeOrder(b.aircraft_type) || a.tail_number.localeCompare(b.tail_number));
  const offgoingPic = rows.filter(r => r.direction === "offgoing" && r.role === "PIC")
    .sort((a, b) => typeOrder(a.aircraft_type) - typeOrder(b.aircraft_type) || a.tail_number.localeCompare(b.tail_number));
  const offgoingSic = rows.filter(r => r.direction === "offgoing" && r.role === "SIC")
    .sort((a, b) => typeOrder(a.aircraft_type) - typeOrder(b.aircraft_type) || a.tail_number.localeCompare(b.tail_number));

  const aoa: (string | number | null)[][] = [];

  // Title
  aoa.push(["", "", "ONCOMING PILOTS"]);
  aoa.push([]);
  aoa.push(["", "", "PILOT IN-COMMAND"]);
  aoa.push(["SB", "Vol", "Name (Home Base)", "Swap Location", "Aircraft", "Flight Number",
    "Date", "Duty On Time", "Arrival Time", "Price", "Notes", "Verified Ticket", "Bonus Eligible", "Bonus Claimed"]);

  for (const r of oncomingPic) {
    aoa.push(dataRow(r, false));
  }

  aoa.push([]);
  aoa.push(["", "", "SECOND IN-COMMAND"]);
  aoa.push(["SB", "Vol", "Name (Home Base)", "Swap Location", "Aircraft", "Flight Number",
    "Date", "Duty On Time", "Arrival Time", "Price", "Notes", "Verified Ticket", "Bonus Eligible", "Bonus Claimed"]);

  for (const r of oncomingSic) {
    aoa.push(dataRow(r, false));
  }

  aoa.push([]);
  aoa.push(["", "", "OFFGOING PILOTS"]);
  aoa.push([]);
  aoa.push(["", "", "PILOT IN-COMMAND"]);
  aoa.push(["SB", "Vol", "Name (Home Base)", "Swap Location", "Aircraft", "Flight Number",
    "Date", "Depart", "Arrival Time", "Price", "Notes", "Verified Ticket", "Bonus Eligible", "Bonus Claimed"]);

  for (const r of offgoingPic) {
    aoa.push(dataRow(r, true));
  }

  aoa.push([]);
  aoa.push(["", "", "SECOND IN-COMMAND"]);
  aoa.push(["SB", "Vol", "Name (Home Base)", "Swap Location", "Aircraft", "Flight Number",
    "Date", "Depart", "Arrival Time", "Price", "Notes", "Verified Ticket", "Bonus Eligible", "Bonus Claimed"]);

  for (const r of offgoingSic) {
    aoa.push(dataRow(r, true));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Set column widths
  ws["!cols"] = [
    { wch: 4 },  // SB
    { wch: 6 },  // Vol
    { wch: 32 }, // Name
    { wch: 14 }, // Swap Location
    { wch: 10 }, // Aircraft
    { wch: 20 }, // Flight Number
    { wch: 12 }, // Date
    { wch: 14 }, // Duty On / Depart
    { wch: 14 }, // Arrival Time
    { wch: 8 },  // Price
    { wch: 40 }, // Notes
    { wch: 14 }, // Verified
    { wch: 14 }, // Bonus Eligible
    { wch: 14 }, // Bonus Claimed
  ];

  XLSX.utils.book_append_sheet(wb, ws, `MAR 18 SWAP`);
  XLSX.writeFile(wb, "public/Charlies Examples/Mar18_optimizer_output.xlsx");
}

function dataRow(r: CrewSwapRow, isOffgoing: boolean): (string | number | null)[] {
  const homeStr = r.home_airports.length > 0 ? ` (${r.home_airports.join("/")})` : "";
  const nameCol = `${r.name}${homeStr}`;
  const dateStr = r.departure_time ? new Date(r.departure_time).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) : "";
  const timeCol = isOffgoing
    ? fmtLocal(r.departure_time)
    : fmtLocal(r.duty_on_time);
  const arrCol = fmtLocal(r.available_time ?? r.arrival_time);
  const priceCol = r.cost_estimate != null ? `$${r.cost_estimate}` : "";
  const volStr = r.volunteer_status || "";
  const sbStr = r.is_skillbridge ? "SB" : "";

  return [
    sbStr,
    volStr,
    nameCol,
    r.swap_location ?? "",
    r.tail_number,
    r.flight_number ?? "",
    dateStr,
    timeCol,
    arrCol,
    priceCol,
    r.notes ?? "",
    "",  // Verified Ticket
    "",  // Bonus Eligible
    "",  // Bonus Claimed
  ];
}

// ─── Run ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
