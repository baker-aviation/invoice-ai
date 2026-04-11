import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-releases
 *
 * List fuel releases with optional filters.
 * Query params:
 *   tail     — filter by tail number
 *   date     — filter by departure_date (YYYY-MM-DD)
 *   status   — filter by status
 *   limit    — max rows (default 100)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = req.nextUrl;
  const tail = searchParams.get("tail");
  const date = searchParams.get("date");
  const status = searchParams.get("status");
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);

  const supa = createServiceClient();
  let query = supa
    .from("fuel_releases")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (tail) query = query.eq("tail_number", tail.toUpperCase());
  if (date) query = query.eq("departure_date", date);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    console.error("[fuel-releases] query error:", error.message);
    return NextResponse.json({ error: "Failed to fetch releases" }, { status: 500 });
  }

  // Sign stored reply attachment URLs so the Release Details modal can
  // render direct PDF links. Failures don't fail the request.
  type StoredAttachment = { name: string; gcs_key: string; gcs_bucket: string; content_type: string; size?: number; uploaded_at?: string };
  const releases = await Promise.all(
    ((data ?? []) as Array<Record<string, unknown>>).map(async (row) => {
      const raw: StoredAttachment[] = Array.isArray(row.reply_attachments)
        ? (row.reply_attachments as StoredAttachment[])
        : [];
      const signed = await Promise.all(
        raw.map(async (a) => {
          let url: string | null = null;
          try {
            url = await signGcsUrl(a.gcs_bucket, a.gcs_key);
          } catch { /* ignore */ }
          return {
            name: a.name,
            content_type: a.content_type,
            size: a.size ?? null,
            uploaded_at: a.uploaded_at ?? null,
            url,
          };
        }),
      );
      return { ...row, reply_attachments: signed };
    }),
  );

  return NextResponse.json({ ok: true, releases });
}
