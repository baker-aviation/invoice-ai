import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { listWeeklySheets, listFreezeSheets } from "@/lib/googleSheets";

export const dynamic = "force-dynamic";

/** GET /api/crew/sheet-weeks — list available weekly swap tabs + freeze tabs from Google Sheets */
export async function GET(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  try {
    const [weeks, freezeTabs] = await Promise.all([
      listWeeklySheets(),
      listFreezeSheets(),
    ]);
    return NextResponse.json({ weeks, freeze_tabs: freezeTabs });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list weeks" },
      { status: 500 },
    );
  }
}
