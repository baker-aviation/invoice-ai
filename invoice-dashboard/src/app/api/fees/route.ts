import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

interface FeeRow {
  date: string;
  vendor: string;
  category: string;
  receipts: string;
  airport: string;
  fbo: string;
  billTo: string;
  createdBy: string;
  gallons: number | null;
  amount: number | null;
  repeats: string;
}

let cachedRows: FeeRow[] | null = null;

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseAmount(raw: string): number | null {
  if (!raw || raw === "null" || raw === "TBD" || raw === "N/A") return null;
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseGallons(raw: string): number | null {
  if (!raw || raw === "null") return null;
  const num = parseFloat(raw.replace(/,/g, ""));
  return isNaN(num) ? null : num;
}

async function loadCSV(): Promise<FeeRow[]> {
  if (cachedRows) return cachedRows;

  const csvPath = path.join(process.cwd(), "public", "data", "fees.csv");
  const text = await fs.readFile(csvPath, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim());

  // Skip header
  const rows: FeeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 11) continue;

    const amount = parseAmount(fields[9]);
    // Skip rows with no amount or $0 amounts
    if (amount === null || amount <= 0) continue;

    const airport = fields[4] === "null" ? "" : fields[4];
    const fbo = fields[5] === "null" ? "" : fields[5];

    rows.push({
      date: fields[0],
      vendor: fields[1],
      category: fields[2],
      receipts: fields[3],
      airport,
      fbo,
      billTo: fields[6] === "Not set" ? "" : fields[6],
      createdBy: fields[7],
      gallons: parseGallons(fields[8]),
      amount,
      repeats: fields[10],
    });
  }

  cachedRows = rows;
  return rows;
}

export async function GET(req: NextRequest) {
  try {
    const rows = await loadCSV();

    const { searchParams } = new URL(req.url);
    const view = searchParams.get("view") || "summary";
    const categoryFilter = searchParams.get("category") || "";
    const airportFilter = searchParams.get("airport") || "";
    const monthFilter = searchParams.get("month") || ""; // e.g. "12/2025" or "01/2026"

    // Filter rows
    let filtered = rows;

    if (categoryFilter) {
      filtered = filtered.filter((r) => r.category === categoryFilter);
    }
    if (airportFilter) {
      filtered = filtered.filter((r) => r.airport === airportFilter);
    }
    if (monthFilter) {
      filtered = filtered.filter((r) => {
        const parts = r.date.split("/");
        return `${parts[0]}/${parts[2]}` === monthFilter;
      });
    }

    if (view === "summary") {
      // Get unique categories with counts and totals
      const catMap = new Map<string, { count: number; total: number; max: number }>();
      for (const r of filtered) {
        const existing = catMap.get(r.category) || { count: 0, total: 0, max: 0 };
        existing.count++;
        existing.total += r.amount!;
        existing.max = Math.max(existing.max, r.amount!);
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

      // Get unique airports
      const airports = [...new Set(filtered.map((r) => r.airport).filter(Boolean))].sort();

      // Get unique months
      const months = [
        ...new Set(
          rows.map((r) => {
            const parts = r.date.split("/");
            return `${parts[0]}/${parts[2]}`;
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
      // Group by airport, rank by total spend
      const airportMap = new Map<
        string,
        { total: number; max: number; count: number; fbo: string; maxVendor: string; maxAmount: number }
      >();
      for (const r of filtered) {
        if (!r.airport) continue;
        const existing = airportMap.get(r.airport) || {
          total: 0,
          max: 0,
          count: 0,
          fbo: "",
          maxVendor: "",
          maxAmount: 0,
        };
        existing.count++;
        existing.total += r.amount!;
        if (r.amount! > existing.maxAmount) {
          existing.max = r.amount!;
          existing.maxAmount = r.amount!;
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

      // Monthly trend
      const monthMap = new Map<string, number>();
      for (const r of filtered) {
        const parts = r.date.split("/");
        const m = `${parts[0]}/${parts[2]}`;
        monthMap.set(m, (monthMap.get(m) || 0) + r.amount!);
      }

      const monthlyTrend = Array.from(monthMap.entries())
        .map(([month, total]) => ({
          month,
          total: Math.round(total * 100) / 100,
        }))
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
      // Group by category at this airport
      const catMap = new Map<
        string,
        { total: number; max: number; count: number; maxVendor: string }
      >();
      for (const r of filtered) {
        const existing = catMap.get(r.category) || { total: 0, max: 0, count: 0, maxVendor: "" };
        existing.count++;
        existing.total += r.amount!;
        if (r.amount! > existing.max) {
          existing.max = r.amount!;
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

      // Top vendors at this airport
      const vendorMap = new Map<string, { total: number; count: number }>();
      for (const r of filtered) {
        const existing = vendorMap.get(r.vendor) || { total: 0, count: 0 };
        existing.count++;
        existing.total += r.amount!;
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
