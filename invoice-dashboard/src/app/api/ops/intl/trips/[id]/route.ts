import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { presignUpload } from "@/lib/gcs-upload";
import { getGcsStorage } from "@/lib/gcs-upload";

type Ctx = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// GET — download clearance file(s) for a trip
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const clearanceId = req.nextUrl.searchParams.get("clearance_id");

  const supa = createServiceClient();

  if (clearanceId) {
    // Single file download
    const { data, error } = await supa
      .from("intl_trip_clearances")
      .select("*")
      .eq("id", clearanceId)
      .eq("trip_id", id)
      .single();

    if (error || !data?.file_gcs_key) {
      return NextResponse.json({ error: "No file attached" }, { status: 404 });
    }

    const storage = await getGcsStorage();
    const [url] = await storage.bucket(data.file_gcs_bucket).file(data.file_gcs_key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 30 * 60 * 1000,
    });
    return NextResponse.json({ download_url: url, filename: data.file_filename });
  }

  // All files for the trip
  const { data: clearances, error } = await supa
    .from("intl_trip_clearances")
    .select("id, clearance_type, airport_icao, file_gcs_bucket, file_gcs_key, file_filename, file_content_type")
    .eq("trip_id", id)
    .not("file_gcs_key", "is", null);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch files" }, { status: 500 });
  }

  const storage = await getGcsStorage();
  const files = await Promise.all(
    (clearances ?? []).map(async (c) => {
      try {
        const [url] = await storage.bucket(c.file_gcs_bucket).file(c.file_gcs_key).getSignedUrl({
          version: "v4",
          action: "read",
          expires: Date.now() + 30 * 60 * 1000,
        });
        return { id: c.id, clearance_type: c.clearance_type, airport_icao: c.airport_icao, filename: c.file_filename, url };
      } catch {
        return null;
      }
    })
  );

  return NextResponse.json({ files: files.filter(Boolean) });
}

// ---------------------------------------------------------------------------
// PATCH — update trip or a specific clearance status
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supa = createServiceClient();

  // If updating a specific clearance
  if (input.clearance_id) {
    const clearanceId = input.clearance_id as string;
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.status !== undefined) {
      if (!["not_started", "submitted", "approved"].includes(input.status as string)) {
        return NextResponse.json({ error: "Invalid status. Must be not_started, submitted, or approved" }, { status: 400 });
      }
      updates.status = input.status;
    }
    if (input.notes !== undefined) updates.notes = input.notes;

    // File upload: generate presigned URL for clearance document
    if (input.filename) {
      const filename = input.filename as string;
      const contentType = (input.content_type as string) || "application/pdf";
      try {
        const upload = await presignUpload(filename, `intl-clearances/${id}`);
        updates.file_gcs_bucket = upload.bucket;
        updates.file_gcs_key = upload.key;
        updates.file_filename = filename;
        updates.file_content_type = contentType;

        // Update the clearance then return with upload_url
        const { error: updErr } = await supa
          .from("intl_trip_clearances")
          .update(updates)
          .eq("id", clearanceId)
          .eq("trip_id", id);

        if (updErr) {
          console.error("[intl/trips] clearance file update error:", updErr);
          return NextResponse.json({ error: "Failed to update clearance" }, { status: 500 });
        }

        // Re-fetch and return with upload URL
        const { data: trip } = await supa
          .from("intl_trips")
          .select("*, clearances:intl_trip_clearances(*)")
          .eq("id", id)
          .single();
        if (trip?.clearances) {
          trip.clearances.sort((a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order);
        }
        return NextResponse.json({ trip, upload_url: upload.url });
      } catch (err) {
        console.error("[intl/trips] presign error:", err);
        return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
      }
    }

    const { error } = await supa
      .from("intl_trip_clearances")
      .update(updates)
      .eq("id", clearanceId)
      .eq("trip_id", id);

    if (error) {
      console.error("[intl/trips] clearance update error:", error);
      return NextResponse.json({ error: "Failed to update clearance" }, { status: 500 });
    }
  }

  // If updating trip-level fields
  if (input.notes !== undefined && !input.clearance_id) {
    await supa
      .from("intl_trips")
      .update({ notes: input.notes, updated_at: new Date().toISOString() })
      .eq("id", id);
  }
  if (input.route_icaos !== undefined) {
    await supa
      .from("intl_trips")
      .update({ route_icaos: input.route_icaos, updated_at: new Date().toISOString() })
      .eq("id", id);
  }

  // Re-fetch
  const { data: trip, error } = await supa
    .from("intl_trips")
    .select("*, clearances:intl_trip_clearances(*)")
    .eq("id", id)
    .single();

  if (error) {
    console.error("[intl/trips] fetch error:", error);
    return NextResponse.json({ error: "Failed to fetch trip" }, { status: 500 });
  }

  // Sort clearances
  if (trip?.clearances) {
    trip.clearances.sort((a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order);
  }

  return NextResponse.json({ trip });
}

// ---------------------------------------------------------------------------
// POST sub-action: add overflight permit clearance to a trip
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const airport_icao = input.airport_icao as string;
  if (!airport_icao) {
    return NextResponse.json({ error: "airport_icao required" }, { status: 400 });
  }

  const clearance_type = (input.clearance_type as string) ?? "overflight_permit";
  if (!["overflight_permit", "landing_permit", "outbound_clearance", "inbound_clearance"].includes(clearance_type)) {
    return NextResponse.json({ error: "Invalid clearance_type" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Get current max sort_order
  const { data: existing } = await supa
    .from("intl_trip_clearances")
    .select("sort_order")
    .eq("trip_id", id)
    .order("sort_order", { ascending: false })
    .limit(1);

  const maxOrder = existing?.[0]?.sort_order ?? 0;

  // Determine sort_order: overflight permits go between outbound and inbound
  // For now, insert at the provided sort_order or after the last existing one
  const sort_order = (input.sort_order as number) ?? maxOrder + 1;

  const { data: clearance, error } = await supa
    .from("intl_trip_clearances")
    .insert({
      trip_id: id,
      clearance_type,
      airport_icao,
      status: "not_started",
      sort_order,
      notes: (input.notes as string) ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error("[intl/trips] add clearance error:", error);
    return NextResponse.json({ error: "Failed to add clearance" }, { status: 500 });
  }

  return NextResponse.json({ clearance }, { status: 201 });
}

// ---------------------------------------------------------------------------
// DELETE — delete a trip or a specific clearance
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const clearanceId = req.nextUrl.searchParams.get("clearance_id");

  const supa = createServiceClient();

  if (clearanceId) {
    // Delete specific clearance (e.g., an overflight permit)
    const { error } = await supa
      .from("intl_trip_clearances")
      .delete()
      .eq("id", clearanceId)
      .eq("trip_id", id);

    if (error) {
      console.error("[intl/trips] delete clearance error:", error);
      return NextResponse.json({ error: "Failed to delete clearance" }, { status: 500 });
    }
  } else {
    // Delete entire trip (cascade deletes clearances)
    const { error } = await supa.from("intl_trips").delete().eq("id", id);
    if (error) {
      console.error("[intl/trips] delete error:", error);
      return NextResponse.json({ error: "Failed to delete trip" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
