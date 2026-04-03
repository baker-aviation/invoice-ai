import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const DEFAULT_LIMIT = 200;
const DEFAULT_EXCLUDED_STATUSES = ["completed", "cancelled"];

/**
 * GET /api/ops/mx-events — list mx_events with filters
 * Query params: status, tail_number, date_from, date_to, priority, assigned_van, limit
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const url = req.nextUrl;
  const statusParam = url.searchParams.get("status");
  const tailNumber = url.searchParams.get("tail_number");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const priority = url.searchParams.get("priority");
  const assignedVan = url.searchParams.get("assigned_van");
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    1000,
  );

  const supa = createServiceClient();
  let query = supa.from("mx_events").select("*", { count: "exact" });

  // Status filter: if provided, filter to those statuses; otherwise exclude completed/cancelled
  if (statusParam) {
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      query = query.in("status", statuses);
    }
  } else {
    for (const s of DEFAULT_EXCLUDED_STATUSES) {
      query = query.neq("status", s);
    }
  }

  if (tailNumber) query = query.eq("tail_number", tailNumber.trim());
  if (priority) query = query.eq("priority", priority.trim());
  if (assignedVan) query = query.eq("assigned_van", parseInt(assignedVan, 10));
  if (dateFrom) query = query.gte("scheduled_date", dateFrom.trim());
  if (dateTo) query = query.lte("scheduled_date", dateTo.trim());

  query = query.order("scheduled_date", { ascending: true, nullsFirst: false }).limit(limit);

  const { data, error, count } = await query;

  if (error) {
    console.error("[ops/mx-events] list error:", error);
    return NextResponse.json({ error: "Failed to list MX events" }, { status: 500 });
  }

  return NextResponse.json({ events: data ?? [], count: count ?? (data ?? []).length });
}

/**
 * POST /api/ops/mx-events — create a new mx_event
 * Required: { title, tail_number }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate required fields
  const title = typeof input.title === "string" ? input.title.trim() : null;
  const tailNumber = typeof input.tail_number === "string" ? input.tail_number.trim() : null;

  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (!tailNumber) return NextResponse.json({ error: "tail_number is required" }, { status: 400 });

  const row: Record<string, unknown> = {
    title,
    tail_number: tailNumber,
  };

  // Optional string fields — trim if provided
  const optionalStrings = [
    "description", "airport_icao", "category", "priority", "status",
    "work_order_ref", "assigned_to", "completed_by",
  ] as const;
  for (const field of optionalStrings) {
    if (input[field] !== undefined) {
      const val = typeof input[field] === "string" ? (input[field] as string).trim() : null;
      row[field] = field === "airport_icao" && val ? val.toUpperCase() : val || null;
    }
  }

  // Optional date/time fields
  const optionalDates = ["scheduled_date", "scheduled_end", "start_time", "end_time"] as const;
  for (const field of optionalDates) {
    if (input[field] !== undefined) row[field] = input[field] || null;
  }

  // Optional numeric fields
  if (input.estimated_hours !== undefined) row.estimated_hours = input.estimated_hours ?? null;
  if (input.assigned_van !== undefined) row.assigned_van = input.assigned_van ?? null;

  const supa = createServiceClient();
  const { data: event, error } = await supa
    .from("mx_events")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    console.error("[ops/mx-events] insert error:", error);
    return NextResponse.json({ error: "Failed to create MX event" }, { status: 500 });
  }

  return NextResponse.json({ event }, { status: 201 });
}
