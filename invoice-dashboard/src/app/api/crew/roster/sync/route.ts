import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import {
  parseCrewInfo,
  type CrewRosterEntry,
  type WeeklySwapEntry,
  type BadPairing,
  type CheckairmanEntry,
  type TrainingEntry,
  type Recurrency299Entry,
  type PicSwapEntry,
  type CrewingChecklist,
  type CalendarWeek,
} from "@/lib/crewInfoParser";
import { downloadAsXlsx } from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/crew/roster/sync
 *
 * Two modes:
 *   1. File upload: multipart/form-data with file field
 *   2. Google Sheets: JSON body with { source: "google_sheets" }
 *
 * Both paths parse through the same crewInfoParser pipeline.
 *
 * Body options:
 *   - file: the .xlsx file (multipart)
 *   - source: "google_sheets" to pull live from Google Sheets (JSON body)
 *   - swap_date: (optional) YYYY-MM-DD to target a specific weekly sheet
 *   - slack_names: (optional) JSON array of Slack display names
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let buffer: Buffer;
  let swapDate: string | null = null;
  let slackNames: string[] | undefined;
  let dataSource = "file_upload";

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    // JSON body — Google Sheets mode
    const body = await req.json();
    if (body.source !== "google_sheets") {
      return NextResponse.json({ error: "JSON body requires source: 'google_sheets'" }, { status: 400 });
    }
    swapDate = body.swap_date ?? null;
    if (body.slack_names) slackNames = body.slack_names;
    // Optional: specific weekly tab to parse (e.g., "MAR 25-APR 1 (A)")
    // If provided, extract the swap date from the tab name
    if (body.week && typeof body.week === "string") {
      const monthMap: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
      // Extract end date from "MAR 25-APR 1 (A)" → the swap Wednesday is the start date
      const m = body.week.match(/([A-Z]{3})\s+(\d+)/i);
      if (m) {
        swapDate = `2026-${monthMap[m[1].toUpperCase()] ?? "03"}-${m[2].padStart(2, "0")}`;
      }
    }
    dataSource = "google_sheets";

    try {
      console.log("[Roster Sync] Downloading CREW INFO from Google Sheets...");
      buffer = await downloadAsXlsx();
      console.log(`[Roster Sync] Downloaded ${(buffer.length / 1024).toFixed(0)}KB from Google Sheets`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[Roster Sync] Google Sheets download failed:", msg);
      return NextResponse.json({ error: `Google Sheets sync failed: ${msg}` }, { status: 500 });
    }
  } else {
    // Multipart form — file upload mode
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

    swapDate = formData.get("swap_date") as string | null;
    const slackNamesRaw = formData.get("slack_names") as string | null;
    if (slackNamesRaw) {
      try {
        slackNames = JSON.parse(slackNamesRaw);
      } catch {
        return NextResponse.json({ error: "slack_names must be valid JSON array" }, { status: 400 });
      }
    }

    buffer = Buffer.from(await file.arrayBuffer());
  }
  const result = parseCrewInfo(buffer, slackNames, swapDate ?? undefined);

  const supa = createServiceClient();
  const syncErrors: string[] = [...result.errors];

  // ═══ 1. Upsert crew_members from CREW ROSTER ═════════════════════════════

  let upsertedCount = 0;
  let deactivatedCount = 0;
  let slackMatchedCount = 0;

  // Preserve grades, restrictions, and checkairman_types before wiping.
  // These are set manually in the app UI and should survive re-syncs.
  const { data: existingCrew } = await supa
    .from("crew_members")
    .select("name, role, grade, restrictions, checkairman_types");
  const preservedData = new Map<string, { grade: number; restrictions: Record<string, boolean>; checkairman_types: string[] }>();
  for (const c of existingCrew ?? []) {
    preservedData.set(`${c.name}|${c.role}`, {
      grade: c.grade ?? 3,
      restrictions: c.restrictions ?? {},
      checkairman_types: c.checkairman_types ?? [],
    });
  }

  // Clean slate: delete all existing crew_members, then insert fresh from Excel.
  // The Excel is the sole source of truth — no merge, no duplicates.
  await supa.from("crew_members").delete().neq("id", "00000000-0000-0000-0000-000000000000"); // delete all rows
  console.log(`[Roster Sync] Cleared crew_members table — inserting fresh from ${dataSource}. Preserved grades for ${preservedData.size} crew.`);

  // JetInsight legal name mappings — these differ from roster display names.
  const JETINSIGHT_NAMES: Record<string, string> = {
    "Wilder Ponte": "Wilder Ponte-Vela",
    "Jesus Olmos": "Jesus Enrique Olmos Arias",
    "Robert Lankford": "Robert Donald Lankford Jr",
    "Hamilton Heatly": "Lawrence Heatly",
    "Eddie Goble": "Edward Goble II",
    "Dave Hill": "Ronald David Hill Jr",
    "Luis Maestre": "Luis Maestre Giron",
    "Chris Unger": "Christopher Unger",
    "Ken Ruth": "Kenneth Ruth",
  };

  // Slack user ID → roster name (from slack-bakeraviation-members.csv export)
  const SLACK_USER_IDS: Record<string, string> = {
    "U06S0M8EF8A": "Aaron Fry", "U0AGZ7RH1EV": "Aaron Lockwood", "U07V2BQ6W6L": "Adam Veres",
    "U08PC5F6MFX": "Adelso Sanchez Tamariz", "U09RQFSSGF3": "Alex Krichevsky",
    "U0A3MBC6CCE": "Alexander Bengoechea", "U08MULS4MED": "Alfredo Cruz",
    "U0ADCCG6NM7": "Andrew Brown", "U04JQ47LD8A": "Andrew Reynolds",
    "U0AFVCSV3ED": "Anthony Ricci", "U08TNTYMP60": "Barry MacDougall",
    "U08DZ865ADA": "Ben Choate", "U0A87SLE9H7": "Bill Betts", "U0A6ZCR36JY": "Bill Bulgier",
    "U0ADVFJHK2A": "Blake Middleton", "U079R3W50BV": "Bob Oliver", "U04AZM86Z7T": "Brad Morton",
    "U09N1RQG2KU": "Brad Weaver", "U06BRRQ0MPB": "Brandon Holloway",
    "U07KP9ZFEQM": "Brian Jenkins", "U08AAMQL0PQ": "Brian Kudrle",
    "U08BSAJASCW": "Bryan Kroneberger", "U0A6D5QCWD8": "Canton Phillips",
    "U09TSQAF4Q2": "Cassidy Wickline", "U08THF9G613": "Charlie Thomas",
    "U0A2GSCNJP2": "Chase Cripps", "U0A2GSALPL0": "Chris Palmer",
    "U0AA1T3JUBY": "Chris Plappert", "U092W98LE3V": "Chris Schaefer",
    "U085C96F45C": "Chris Unger", "U08DZ860H6G": "Chris Wilson", "U08PC5CKL85": "Chris Wood",
    "U08K6C6RFQT": "Cole Kunze", "U09H3R740AD": "Collin Buell", "U093351572N": "Colt Mansfield",
    "U087830PK2M": "Curtis Phillips", "U09MZPJN7L6": "Dan Cruz",
    "U09TTSSMG2F": "Daniel Dusold", "U09U5MPTT17": "Daniel Edwards",
    "U0A59AQKGCW": "Daniel Mack", "U09UNQ80WJG": "Daniel Minarro",
    "U0A6ZCSEAAG": "Daniel Mustin", "U0ACT39R1L3": "Danny Wright",
    "U0A1NH1HDA6": "Darin Moody", "U0ADXHE6CV8": "Dave Hill", "U094MNHEMQ9": "David Cerise",
    "U0A9X8QCKFH": "David Metcalf", "U09334XUPPC": "David Wiersma",
    "U09TPBAAW13": "Devin Holbrook", "U0AACMN5GUS": "Donald McCroan",
    "U08THFCRP5K": "Douglas Conwell", "U0A8P8DS09E": "Eddie Goble",
    "U079R7ENPDG": "Edward Blasko", "U0ABSD7E02Z": "Edward Green",
    "U09H3R70733": "Edward Ley", "U0A7RFYCA5B": "Elizabeth Leus",
    "U07LF07KA48": "Eric Gordy", "U0A1LG1S2R4": "Eric Tallberg",
    "U04JSHV4XA8": "Erik Scheller", "U0AACMLCH0S": "Evan Gutierrez",
    "U0ABTQAHN0N": "Felicia Rindon", "U08PHLRRM5G": "Fernand Muffoletto",
    "U09TWBU9R4L": "Fred Fields", "U0A5BBJK4DQ": "Frederick Gilman",
    "U08L68M5SM8": "Graeme Lang", "U076KVB3ZUJ": "Gregory Dworek",
    "U09UD5ZQK7T": "Guillermo Garcia-Galdamez", "U09RQFVF5TK": "Hamilton Heatly",
    "U09U3RL5QHJ": "Hector Rodriguez", "U07G9D80H9N": "Henry Brown",
    "U0AAGS3ASGH": "Henry Freund", "U09BYGGSE9Y": "Jack Newberry",
    "U0A4WB0QFGR": "Jacob Spencer", "U05EQAJC31Q": "James Latshaw",
    "U0A8Y8QKATG": "James Latshaw", "U0971HT764C": "James MacGregor",
    "U06MTCH1VLP": "James Stevens", "U0A9PE870M9": "James Sullivan",
    "U0AD333U3B6": "Jansen Valk", "U0A1G5M33A7": "Jason Stanton",
    "U09BYGEHUCA": "Jeffray Graham", "U08L68L1HV0": "Jesus Olmos",
    "U0AA1T4CJJ2": "Jimmy Houston", "U076YKH4APK": "John Buerschen",
    "U0A9X8RHCRM": "John Caputo", "U04AZM7KEF3": "John Haslett",
    "U0AF11RH8J3": "John Sedmak", "U0A9VR8UHU2": "John Sterling",
    "U085XJ7QAKT": "Jon Davis", "U08THF74KQV": "Jon Huggins",
    "U04JM5UG01K": "Jon Spencer", "U0A5Q9LPWRX": "Jonathan Stack",
    "U06G4TXVACF": "Jordan Edwards", "U0AA0FUANUV": "Jordan Thomas",
    "U096XCUM19C": "Joseph Browning", "U0A5Q9PNAP3": "Joseph Champion",
    "U07HYH1G5QS": "Joseph Grande", "U076KS12UKD": "Joshua Barabe",
    "U09MLBVAVM5": "Joshua Raymond", "U07E378QPJ5": "Justin Harris",
    "U0AAY80QHFS": "Justin Neal", "U09C0P0L7GW": "Justin Wasno",
    "U096XCXM3SS": "Kai Gamble", "U058ZSWE456": "Karl Lenker",
    "U08PHLS9KLJ": "Ken Ruth", "U06RXPKG6TF": "Kevin Carter",
    "U0ADG463HQX": "Kevin Scott", "U0A7STML17G": "Kurtis Beck",
    "U08K6C5CLCT": "Kyle Lund", "U0AHZ26U84E": "Kyle Wilson",
    "U09N1RP2Z9Q": "Larry Swearingen", "U08PHLPD3DY": "Leonard Pangelinan",
    "U0A57UJFAKF": "Levi Schmid", "U08K6C85P7V": "Lionel Macklin",
    "U088MQ3RY2X": "Luis Maestre", "U062F09RJ5N": "Mark Lang",
    "U079NA3A8ER": "Mark Smith", "U09C0NVUJG6": "Martin Saine",
    "U09H3R6HTH7": "Matt Hill", "U09334T5N6N": "Matt Kim",
    "U070L6D4K7W": "Matthew Curry", "U0A65LZ7VRN": "Maurice Stander",
    "U0A7YGUQ8MA": "Mauricio Alves", "U08BHV6E1U0": "Michael Bellis",
    "U0AA0FXQB9T": "Michael Frost", "U08R85YHLSW": "Michael Hutka",
    "U05U93BHS8Y": "Mike Beard", "U0AFVCEE2QZ": "Nick Antognini",
    "U0A59ARM686": "Nick Asarese", "U09334VGXSN": "Nick Seeberger",
    "U09C0P54ZAS": "Nick Steele", "U086SGVMK6H": "Patrick Finley",
    "U066B1A3RJ7": "Patrick Larance", "U09SFCHJYE5": "Patrick McLoughlin",
    "U08PHLU3MJN": "Patrick Snowman", "U0AF16NRT9A": "Randy Weakley",
    "U09UUJ64E7J": "Rick Ferrin", "U07DMKXAA8M": "Rick Taylor",
    "U0A78N8PMUH": "Rob Whittin", "U0AGPUAE2P6": "Robert Lankford",
    "U053RU1PHGV": "Rodolfo Garcia", "U0AACMMHRTL": "Ross Lannin",
    "U04A6FUQF63": "Roy White", "U07UDHHCFNE": "Russell Bonds",
    "U0AJVBYJM2L": "Ryan Delannoy", "U097CEWF51Q": "Ryan Lofswold",
    "U096XCW4MF0": "Ryan Moore", "U07R79TDH0U": "Scott Leach",
    "U07L4S1S76V": "Scott Moore", "U079R42ATT5": "Sean Brammer-Hogan",
    "U0A1LG27DHC": "Sebastian Rodriquez", "U0A7RFZQCKF": "Sloan Parker",
    "U052Y4FPTAP": "Stephen Smith", "U0AEVGJBUP8": "Terry Smith",
    "U070HN1FG6N": "Tim Kerner", "U08THFEHDPX": "Timothy Locke",
    "U0A1K4CFCP7": "Todd Ratzlaff", "U09R56VE2DR": "Tony Frandino",
    "U0AGCD16L65": "Travis Douglas", "U09MYBVDWUD": "Travis Farewell",
    "U0AFL3G0QPN": "Tyler Bachelder", "U0AFA3LB1D1": "Tyler Marsh",
    "U058ZSWBSCQ": "Victoria Larson", "U0A11MECS3G": "Ward Lewis",
    "U0A3H15K719": "Wesley Williamson", "U09BXUK9XSB": "Wilder Ponte",
    "U04JHFYJ1L6": "Will Hecox", "U04KPPAFPJB": "Will Hecox",
    "U0A57UJQM8V": "Zach Done", "U070ASQAXL2": "Zack Benz",
  };

  // Build reverse map: roster name → slack_user_id
  const rosterToSlackId = new Map<string, string>();
  for (const [uid, name] of Object.entries(SLACK_USER_IDS)) {
    if (!rosterToSlackId.has(name)) rosterToSlackId.set(name, uid);
  }

  // Build checkairman lookup from parsed data (needed during insert)
  const checkairmanTypeMap = new Map<string, { citation_x: boolean; challenger: boolean }>();
  for (const ca of result.checkairmen) {
    const existing = checkairmanTypeMap.get(ca.name);
    if (existing) {
      if (ca.citation_x) existing.citation_x = true;
      if (ca.challenger) existing.challenger = true;
    } else {
      checkairmanTypeMap.set(ca.name, { citation_x: ca.citation_x, challenger: ca.challenger });
    }
  }

  // No existing map needed — everything is new
  const existingMap = new Map<string, { id: string; slack_display_name: string | null }>();

  // Track which names are in the new roster (to deactivate removed ones)
  const rosterKeys = new Set<string>();

  for (const entry of result.roster) {
    const key = `${entry.name}|${entry.role}`;
    rosterKeys.add(key);

    // Check if this crew member is a checkairman (from parsed checkairmen data)
    const caEntry = checkairmanTypeMap.get(entry.name);
    const isCA = !!caEntry || result.checkairmen.some((ca) => ca.name === entry.name);

    // Restore preserved grade and restrictions from previous sync
    const preserved = preservedData.get(`${entry.name}|${entry.role}`);

    // Build checkairman_types from parsed Excel data
    const caTypes: string[] = [];
    if (caEntry) {
      if (caEntry.citation_x) caTypes.push("citation_x");
      if (caEntry.challenger) caTypes.push("challenger");
    }
    // If no parsed CA types but we had them before, keep the old ones
    const finalCaTypes = caTypes.length > 0 ? caTypes : (preserved?.checkairman_types ?? []);

    const record: Record<string, unknown> = {
      name: entry.name,
      role: entry.role,
      home_airports: entry.home_airports,
      aircraft_types: [entry.aircraft_type],
      rotation_group: entry.rotation === "part_time" ? null : entry.rotation,
      is_skillbridge: entry.is_skillbridge,
      is_checkairman: isCA,
      checkairman_types: finalCaTypes,
      grade: preserved?.grade ?? 3,
      restrictions: preserved?.restrictions ?? {},
      active: !entry.is_terminated,
      updated_at: new Date().toISOString(),
    };

    // Store Slack display name if matched
    if (entry.slack_display_name) {
      record.slack_display_name = entry.slack_display_name;
      slackMatchedCount++;
    }

    // Store JetInsight legal name if different from display name
    if (JETINSIGHT_NAMES[entry.name]) {
      record.jetinsight_name = JETINSIGHT_NAMES[entry.name];
    }

    // Store Slack user ID for volunteer matching
    const slackId = rosterToSlackId.get(entry.name);
    if (slackId) {
      record.slack_user_id = slackId;
    }

    // Add notes for SkillBridge end date and termination
    const notesParts: string[] = [];
    if (entry.skillbridge_end) notesParts.push(`SB ends ${entry.skillbridge_end}`);
    if (entry.terminated_on) notesParts.push(`Terminated ${entry.terminated_on}`);
    if (entry.rotation === "part_time") notesParts.push("Part-time / Non-standard rotation");
    if (notesParts.length > 0) record.notes = notesParts.join("; ");

    try {
      const existing = existingMap.get(key);
      if (existing) {
        // Don't overwrite existing slack_display_name if we didn't get a new one
        if (!entry.slack_display_name && existing.slack_display_name) {
          delete record.slack_display_name;
        }
        await supa.from("crew_members").update(record).eq("id", existing.id);
      } else {
        await supa.from("crew_members").insert(record);
      }
      upsertedCount++;
    } catch (e) {
      syncErrors.push(`${entry.name}: ${e instanceof Error ? e.message : "upsert failed"}`);
    }
  }

  // No deactivation needed — we wiped and re-inserted from Excel.
  // Terminated crew are already marked active: false in the insert above.
  {
  }

  // ═══ 2. Checkairman flags already set during insert (from parsed checkairmen data) ════

  // ═══ 3. Build swap assignments from weekly sheet ══════════════════════════

  type SwapAssignment = {
    oncoming_pic: string | null;
    oncoming_sic: string | null;
    offgoing_pic: string | null;
    offgoing_sic: string | null;
  };

  const swapByTail = new Map<string, SwapAssignment>();
  type PoolEntry = {
    name: string;
    aircraft_type: string;
    home_airports: string[];
    is_checkairman: boolean;
    is_skillbridge: boolean;
    early_volunteer: boolean;
    late_volunteer: boolean;
    standby_volunteer: boolean;
    notes: string | null;
  };
  const oncomingPool: { pic: PoolEntry[]; sic: PoolEntry[] } = { pic: [], sic: [] };
  const standbyPool: { pic: PoolEntry[]; sic: PoolEntry[] } = { pic: [], sic: [] };

  if (result.weekly_swap) {
    // Build offgoing assignments (they have tail numbers)
    for (const e of result.weekly_swap.filter((e) => e.direction === "offgoing" && e.tail_number)) {
      const tail = e.tail_number!;
      if (!swapByTail.has(tail)) {
        swapByTail.set(tail, { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null });
      }
      const sa = swapByTail.get(tail)!;
      if (e.role === "PIC") sa.offgoing_pic = e.name;
      else sa.offgoing_sic = e.name;
    }

    // Oncoming with tails (including "Staying on")
    for (const e of result.weekly_swap.filter((e) => e.direction === "oncoming" && e.tail_number)) {
      const tail = e.tail_number!;
      if (!swapByTail.has(tail)) {
        swapByTail.set(tail, { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null });
      }
      const sa = swapByTail.get(tail)!;
      if (e.role === "PIC") sa.oncoming_pic = e.name;
      else sa.oncoming_sic = e.name;
    }

    // Oncoming without tails → pool or standby
    const assignedOncoming = new Set<string>();
    for (const [, sa] of swapByTail) {
      if (sa.oncoming_pic) assignedOncoming.add(sa.oncoming_pic);
      if (sa.oncoming_sic) assignedOncoming.add(sa.oncoming_sic);
    }

    for (const e of result.weekly_swap.filter((e) => e.direction === "oncoming" && !e.tail_number)) {
      if (assignedOncoming.has(e.name)) continue;

      const poolEntry: PoolEntry = {
        name: e.name,
        aircraft_type: e.aircraft_type,
        home_airports: e.home_airports,
        is_checkairman: e.is_checkairman,
        is_skillbridge: e.is_skillbridge,
        early_volunteer: e.volunteer === "early",
        late_volunteer: e.volunteer === "late",
        standby_volunteer: e.volunteer === "standby",
        notes: e.notes,
      };

      // Check if this person is on standby (notes mention STANDBY)
      const isStandby = e.notes?.toUpperCase().includes("STANDBY") || e.volunteer === "standby";

      if (isStandby) {
        if (e.role === "PIC") standbyPool.pic.push(poolEntry);
        else standbyPool.sic.push(poolEntry);
      } else {
        if (e.role === "PIC") oncomingPool.pic.push(poolEntry);
        else oncomingPool.sic.push(poolEntry);
      }
    }
  }

  // Convert swap assignments to plain object
  const swapAssignments: Record<string, SwapAssignment> = {};
  for (const [tail, sa] of swapByTail) {
    swapAssignments[tail] = sa;
  }

  // Determine rotation groups
  const oncomingNames = result.weekly_swap
    ?.filter((e) => e.direction === "oncoming")
    .map((e) => e.name) ?? [];
  const offgoingNames = result.weekly_swap
    ?.filter((e) => e.direction === "offgoing")
    .map((e) => e.name) ?? [];

  // Infer rotation from the sheet name (e.g., "MAR 18-MAR 25 (B)" → offgoing is B)
  let offgoingGroup: "A" | "B" = "B";
  let oncomingGroup: "A" | "B" = "A";
  if (result.weekly_sheet_name) {
    const rotMatch = result.weekly_sheet_name.match(/\(([AB])\)/);
    if (rotMatch) {
      // The sheet is named after the OFFGOING rotation (the crew leaving)
      offgoingGroup = rotMatch[1] as "A" | "B";
      oncomingGroup = offgoingGroup === "A" ? "B" : "A";
    }
  }

  // ═══ 4. Different airports summary ════════════════════════════════════════

  // Filter to entries relevant to the swap date (if provided)
  let relevantDiffAirports = result.different_airports;
  if (swapDate) {
    relevantDiffAirports = result.different_airports.filter((d) => {
      if (!d.date) return true; // undated entries always relevant
      return d.date === swapDate;
    });
  }

  // ═══ 5. Find target week from calendar_weeks ════════════════════════════

  let targetWeekCrew: CalendarWeek | null = null;
  if (result.calendar_weeks.length > 0) {
    // Try to match the swap_date to a calendar week's date range
    if (swapDate) {
      const targetTs = new Date(swapDate + "T12:00:00Z").getTime();

      // Find the rotation that starts on swap day (oncoming crew, not current/offgoing)
      for (const week of result.calendar_weeks) {
        // date_range looks like "March 18, 2026 - March 25, 2026"
        const rangeParts = week.date_range.split(/\s*-\s*/);
        if (rangeParts.length !== 2) continue;
        const startTs = new Date(rangeParts[0].trim() + " 00:00:00 UTC").getTime();
        if (isNaN(startTs)) continue;
        // Match the week that starts on or within 1 day of the swap date
        if (Math.abs(startTs - targetTs) <= 86400_000) {
          targetWeekCrew = week;
          break;
        }
      }
    }

    // Fallback: find the next upcoming week (first week whose start >= today)
    if (!targetWeekCrew) {
      const now = Date.now();
      for (const week of result.calendar_weeks) {
        const rangeParts = week.date_range.split(/\s*-\s*/);
        if (rangeParts.length !== 2) continue;
        const startTs = new Date(rangeParts[0].trim() + " 00:00:00 UTC").getTime();
        if (isNaN(startTs)) continue;
        if (startTs >= now) {
          targetWeekCrew = week;
          break;
        }
      }
      // If all weeks are in the past, use the last one
      if (!targetWeekCrew) {
        targetWeekCrew = result.calendar_weeks[result.calendar_weeks.length - 1];
      }
    }
  }

  // ═══ Response ═════════════════════════════════════════════════════════════

  return NextResponse.json({
    ok: true,
    source: dataSource,
    roster: {
      total: result.roster.length,
      active: result.roster.filter((r) => !r.is_terminated).length,
      terminated: result.roster.filter((r) => r.is_terminated).length,
      skillbridge: result.roster.filter((r) => r.is_skillbridge).length,
      part_time: result.roster.filter((r) => r.rotation === "part_time").length,
      upserted: upsertedCount,
      deactivated: deactivatedCount,
    },
    slack: {
      provided: slackNames?.length ?? 0,
      matched: slackMatchedCount,
      unmatched: (slackNames?.length ?? 0) - slackMatchedCount,
    },
    rotation: {
      oncoming_group: oncomingGroup,
      offgoing_group: offgoingGroup,
      counts: result.rotation_counts,
    },
    weekly_sheet: result.weekly_sheet_name,
    swap_assignments: swapAssignments,
    oncoming_pool: oncomingPool,
    standby_pool: standbyPool,
    different_airports: relevantDiffAirports,
    bad_pairings: result.bad_pairings,
    checkairmen: result.checkairmen,
    training_needed: result.training_needed,
    recurrency_299: result.recurrency_299,
    pic_swap_table: result.pic_swap_table,
    crewing_checklist: result.crewing_checklist,
    calendar_weeks: result.calendar_weeks,
    target_week_crew: targetWeekCrew,
    errors: syncErrors.length > 0 ? syncErrors : undefined,
  });
}
