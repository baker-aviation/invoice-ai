import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { listWeeklySheets } from "@/lib/googleSheets";

export const dynamic = "force-dynamic";

/** GET /api/crew/sheet-weeks — list available weekly swap tabs from Google Sheets */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const weeks = await listWeeklySheets();
    return NextResponse.json({ weeks });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list weeks" },
      { status: 500 },
    );
  }
}
