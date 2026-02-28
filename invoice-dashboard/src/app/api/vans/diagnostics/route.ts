import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";

// Call Samsara API directly (avoids Cloud Run IAM auth issues)
const SAMSARA_BASE = "https://api.samsara.com";

interface SamsaraFaultValue {
  activeCodes?: unknown[];
  activeDtcIds?: unknown[];
}

interface SamsaraVehicleDiag {
  id?: string;
  name?: string;
  obdOdometerMeters?: { value?: number; time?: string };
  faultCodes?: { value?: SamsaraFaultValue | unknown[]; time?: string };
}

export async function GET(req: NextRequest) {
  // Diagnostics = admin-only
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "SAMSARA_API_KEY not configured" },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(
      `${SAMSARA_BASE}/fleet/vehicles/stats?types=obdOdometerMeters,faultCodes`,
      { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Samsara API error: HTTP ${res.status}`, detail: body.slice(0, 300) },
        { status: 502 },
      );
    }
    const json = await res.json();
    const raw = (json.data ?? []) as SamsaraVehicleDiag[];

    const vehicles = raw.map((v) => {
      const odo = v.obdOdometerMeters ?? {};
      const fc = v.faultCodes ?? {};
      const odoMeters = odo.value;

      // faultCodes.value structure varies by gateway — handle both dict and list
      const fcVal = fc.value;
      let active: unknown[] = [];
      if (Array.isArray(fcVal)) {
        active = fcVal;
      } else if (fcVal && typeof fcVal === "object") {
        const fv = fcVal as SamsaraFaultValue;
        active = fv.activeCodes ?? fv.activeDtcIds ?? [];
      }

      return {
        id: v.id ?? null,
        name: v.name ?? null,
        odometer_miles:
          odoMeters != null ? Math.round(odoMeters / 1609.344) : null,
        check_engine_on: active.length > 0,
        fault_codes: active,
        diag_time: odo.time ?? fc.time ?? null,
      };
    });

    return NextResponse.json({ ok: true, vehicles, count: vehicles.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Samsara API unreachable", detail: String(err) },
      { status: 502 },
    );
  }
}
