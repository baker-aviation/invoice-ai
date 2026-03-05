import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

interface ExpenseRow {
  expense_date: string;
  vendor: string;
  category: string;
  receipts: string;
  airport: string;
  fbo: string;
  bill_to: string;
  created_by: string;
  gallons: number | null;
  amount: number;
  repeats: string;
  uploaded_at: string;
  upload_batch: string | null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(req.url);
  const view = searchParams.get("view") || "summary";
  const categoryFilter = searchParams.get("category") || "";
  const airportFilter = searchParams.get("airport") || "";
  const monthFilter = searchParams.get("month") || "";

  const supa = createServiceClient();

  try {
    // --- uploads view: show distinct upload batches ---
    if (view === "uploads") {
      const { data, error } = await supa
        .from("expenses")
        .select("upload_batch, uploaded_at")
        .order("uploaded_at", { ascending: false });

      if (error) throw error;

      // Group by batch
      const batchMap = new Map<string, { uploadedAt: string; count: number }>();
      for (const row of data ?? []) {
        const batch = row.upload_batch || "unknown";
        const existing = batchMap.get(batch);
        if (!existing) {
          batchMap.set(batch, { uploadedAt: row.uploaded_at, count: 1 });
        } else {
          existing.count++;
        }
      }

      // Also get date range per batch
      const { data: dateRanges } = await supa
        .from("expenses")
        .select("upload_batch, expense_date")
        .order("expense_date", { ascending: true });

      const batchDates = new Map<string, { minDate: string; maxDate: string }>();
      for (const row of dateRanges ?? []) {
        const batch = row.upload_batch || "unknown";
        const existing = batchDates.get(batch);
        if (!existing) {
          batchDates.set(batch, { minDate: row.expense_date, maxDate: row.expense_date });
        } else {
          if (row.expense_date < existing.minDate) existing.minDate = row.expense_date;
          if (row.expense_date > existing.maxDate) existing.maxDate = row.expense_date;
        }
      }

      const uploads = Array.from(batchMap.entries()).map(([batch, info]) => ({
        batch,
        uploadedAt: info.uploadedAt,
        rowCount: info.count,
        ...(batchDates.get(batch) ?? {}),
      }));

      return NextResponse.json({ ok: true, uploads });
    }

    // --- Fetch all rows (with filters applied via query) ---
    let query = supa
      .from("expenses")
      .select("expense_date, vendor, category, receipts, airport, fbo, bill_to, created_by, gallons, amount, repeats, uploaded_at, upload_batch")
      .gt("amount", 0)
      .order("expense_date", { ascending: false });

    if (categoryFilter) query = query.eq("category", categoryFilter);
    if (airportFilter) query = query.eq("airport", airportFilter);
    if (monthFilter) {
      // monthFilter is "MM/YYYY" — convert to date range
      const [mm, yyyy] = monthFilter.split("/");
      if (mm && yyyy) {
        const start = `${yyyy}-${mm.padStart(2, "0")}-01`;
        const endMonth = parseInt(mm);
        const endYear = endMonth === 12 ? parseInt(yyyy) + 1 : parseInt(yyyy);
        const endMM = endMonth === 12 ? 1 : endMonth + 1;
        const end = `${endYear}-${String(endMM).padStart(2, "0")}-01`;
        query = query.gte("expense_date", start).lt("expense_date", end);
      }
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const filtered = (rows ?? []) as ExpenseRow[];

    if (view === "summary") {
      const catMap = new Map<string, { count: number; total: number; max: number }>();
      for (const r of filtered) {
        const existing = catMap.get(r.category) || { count: 0, total: 0, max: 0 };
        existing.count++;
        existing.total += Number(r.amount);
        existing.max = Math.max(existing.max, Number(r.amount));
        catMap.set(r.category, existing);
      }

      const categories = Array.from(catMap.entries())
        .map(([name, stats]) => ({
          name,
          count: stats.count,
          total: Math.round(stats.total * 100) / 100,
          max: Math.round(stats.max * 100) / 100,
          avg: Math.round((stats.total / stats.count) * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total);

      const airports = [...new Set(filtered.map((r) => r.airport).filter(Boolean))].sort();

      const months = [
        ...new Set(
          filtered.map((r) => {
            const d = new Date(r.expense_date);
            return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
          }),
        ),
      ].sort();

      return NextResponse.json({
        ok: true,
        totalRows: filtered.length,
        categories,
        airports,
        months,
      });
    }

    if (view === "by-category") {
      const airportMap = new Map<
        string,
        { total: number; max: number; count: number; fbo: string; maxVendor: string; maxAmount: number }
      >();
      for (const r of filtered) {
        if (!r.airport) continue;
        const existing = airportMap.get(r.airport) || {
          total: 0, max: 0, count: 0, fbo: "", maxVendor: "", maxAmount: 0,
        };
        existing.count++;
        existing.total += Number(r.amount);
        if (Number(r.amount) > existing.maxAmount) {
          existing.max = Number(r.amount);
          existing.maxAmount = Number(r.amount);
          existing.maxVendor = r.vendor;
          existing.fbo = r.fbo;
        }
        airportMap.set(r.airport, existing);
      }

      const byAirport = Array.from(airportMap.entries())
        .map(([airport, stats]) => ({
          airport,
          fbo: stats.fbo,
          count: stats.count,
          total: Math.round(stats.total * 100) / 100,
          max: Math.round(stats.max * 100) / 100,
          avg: Math.round((stats.total / stats.count) * 100) / 100,
          maxVendor: stats.maxVendor,
        }))
        .sort((a, b) => b.total - a.total);

      const monthMap = new Map<string, number>();
      for (const r of filtered) {
        const d = new Date(r.expense_date);
        const m = `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        monthMap.set(m, (monthMap.get(m) || 0) + Number(r.amount));
      }

      const monthlyTrend = Array.from(monthMap.entries())
        .map(([month, total]) => ({ month, total: Math.round(total * 100) / 100 }))
        .sort((a, b) => a.month.localeCompare(b.month));

      return NextResponse.json({
        ok: true,
        category: categoryFilter,
        totalRows: filtered.length,
        byAirport,
        monthlyTrend,
      });
    }

    if (view === "by-airport") {
      const catMap = new Map<string, { total: number; max: number; count: number; maxVendor: string }>();
      for (const r of filtered) {
        const existing = catMap.get(r.category) || { total: 0, max: 0, count: 0, maxVendor: "" };
        existing.count++;
        existing.total += Number(r.amount);
        if (Number(r.amount) > existing.max) {
          existing.max = Number(r.amount);
          existing.maxVendor = r.vendor;
        }
        catMap.set(r.category, existing);
      }

      const byCategory = Array.from(catMap.entries())
        .map(([category, stats]) => ({
          category,
          count: stats.count,
          total: Math.round(stats.total * 100) / 100,
          max: Math.round(stats.max * 100) / 100,
          avg: Math.round((stats.total / stats.count) * 100) / 100,
          maxVendor: stats.maxVendor,
        }))
        .sort((a, b) => b.total - a.total);

      const vendorMap = new Map<string, { total: number; count: number }>();
      for (const r of filtered) {
        const existing = vendorMap.get(r.vendor) || { total: 0, count: 0 };
        existing.count++;
        existing.total += Number(r.amount);
        vendorMap.set(r.vendor, existing);
      }

      const topVendors = Array.from(vendorMap.entries())
        .map(([vendor, stats]) => ({
          vendor,
          count: stats.count,
          total: Math.round(stats.total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15);

      return NextResponse.json({
        ok: true,
        airport: airportFilter,
        totalRows: filtered.length,
        byCategory,
        topVendors,
      });
    }

    // Raw rows (paginated)
    const page = parseInt(searchParams.get("page") || "0");
    const limit = 50;
    const start = page * limit;
    const pageRows = filtered.slice(start, start + limit);

    return NextResponse.json({
      ok: true,
      totalRows: filtered.length,
      page,
      rows: pageRows,
    });
  } catch (err) {
    console.error("Fee data error:", err);
    return NextResponse.json({ ok: false, error: "Failed to load fee data" }, { status: 500 });
  }
}
