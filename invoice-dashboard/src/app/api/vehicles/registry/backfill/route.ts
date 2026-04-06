import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const SAMSARA_BASE = "https://api.samsara.com";

interface SamsaraVehicle {
  id: string;
  name?: string;
  make?: string;
  model?: string;
}

function inferType(name: string, make: string, model: string): string {
  const u = name.toUpperCase();
  const m = model.toUpperCase();
  const mk = make.toUpperCase();
  const all = `${u} ${mk} ${m}`;

  if (u.includes("CLEANING")) return "cleaning";
  if (m.includes("BRONCO") || u.includes("BRONCO")) return "suv";
  if (/F[-\s]?\d{3}/.test(m) || m.includes("SUPER DUTY") || all.includes("TRUCK")) return "truck";
  if (u.includes("VAN") || u.includes("AOG") || u.includes("TRAN")) return "van";
  if (m.includes("CAMRY") || mk.includes("BMW") || u.includes("CAMRY") || u.includes("BMW") || u.includes("CAR")) return "crew_car";
  return "unknown";
}

function inferRole(type: string): string {
  switch (type) {
    case "van": return "aog_response";
    case "truck": return "parts_transport";
    case "suv": return "aog_response";
    case "crew_car": return "crew_shuttle";
    case "cleaning": return "utility";
    default: return "unassigned";
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "SAMSARA_API_KEY not configured" }, { status: 503 });

  // Fetch all vehicles with make/model from Samsara
  const vehicles: SamsaraVehicle[] = [];
  let url: string | null = `${SAMSARA_BASE}/fleet/vehicles?limit=200`;
  let page = 0;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: `Samsara HTTP ${res.status}` }, { status: 502 });
    const json = await res.json();
    vehicles.push(...(json.data ?? []));
    if (json.pagination?.hasNextPage && json.pagination?.endCursor) {
      url = `${SAMSARA_BASE}/fleet/vehicles?limit=200&after=${encodeURIComponent(json.pagination.endCursor)}`;
    } else {
      url = null;
    }
    if (++page > 10) break;
  }

  const supa = createServiceClient();
  let updated = 0;
  let reclassified = 0;

  for (const v of vehicles) {
    const make = v.make ?? "";
    const model = v.model ?? "";
    const vType = inferType(v.name ?? "", make, model);
    const vRole = inferRole(vType);

    const { data: existing } = await supa
      .from("vehicle_registry")
      .select("vehicle_type")
      .eq("samsara_id", v.id)
      .single();

    if (existing) {
      const updates: Record<string, unknown> = {
        make: make || null,
        model: model || null,
        updated_at: new Date().toISOString(),
      };
      // Reclassify if current type was inferred from name and model says otherwise
      if (existing.vehicle_type !== vType && (existing.vehicle_type === "unknown" || existing.vehicle_type === "van")) {
        updates.vehicle_type = vType;
        updates.vehicle_role = vRole;
        reclassified++;
      }
      await supa.from("vehicle_registry").update(updates).eq("samsara_id", v.id);
      updated++;
    }
  }

  const summary = { samsara_vehicles: vehicles.length, updated, reclassified };
  console.log("[registry/backfill]", summary);
  return NextResponse.json({ ok: true, ...summary });
}
