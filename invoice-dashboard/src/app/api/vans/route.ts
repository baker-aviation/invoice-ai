import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const base = process.env.OPS_API_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // Debug: identify which SA key is being used
  const saRaw = process.env.GCP_SA_KEY;
  let saEmail = "(no GCP_SA_KEY)";
  if (saRaw) {
    try {
      const json = saRaw.trimStart().startsWith("{")
        ? saRaw
        : Buffer.from(saRaw, "base64").toString("utf-8");
      saEmail = JSON.parse(json).client_email ?? "(no client_email)";
    } catch { saEmail = "(parse error)"; }
  }

  try {
    const res = await cloudRunFetch(`${base}/api/vans`, { cache: "no-store" });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      const cleaned = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      return NextResponse.json(
        { error: `Upstream HTTP ${res.status}: ${cleaned || "(empty body)"}`, debug: { sa: saEmail, target: base } },
        { status: 502 },
      );
    }
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return NextResponse.json(
      { error: "Upstream unavailable", detail: String(err), debug: { sa: saEmail, target: base } },
      { status: 502 },
    );
  }
}
