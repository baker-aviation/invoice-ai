export const dynamic = "force-dynamic";

import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/service";

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

type DashboardStats = {
  flights7d: number;
  flightsToday: number;
  activeAlerts24h: number;
  activeEdcts: number;
  airborne: number;
  totalInvoices: number;
  invoicesPending: number;
  feeAlertsPending: number;
  jobApplications: number;
  jobsNeedReview: number;
};

async function fetchStats(): Promise<DashboardStats> {
  const supa = createServiceClient();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);
  const weekOut = new Date(now.getTime() + 7 * 24 * 3600_000);

  const ago24h = new Date(now.getTime() - 24 * 3600_000);

  const [
    flights7dRes,
    flightsTodayRes,
    activeAlerts24hRes,
    activeEdctsRes,
    airborneRes,
    totalInvoicesRes,
    invoicesPendingRes,
    feeAlertsPendingRes,
    jobApplicationsRes,
    jobsNeedReviewRes,
  ] = await Promise.all([
    supa.from("flights").select("id", { count: "exact", head: true })
      .gte("scheduled_departure", now.toISOString())
      .lte("scheduled_departure", weekOut.toISOString()),
    supa.from("flights").select("id", { count: "exact", head: true })
      .gte("scheduled_departure", todayStart.toISOString())
      .lt("scheduled_departure", todayEnd.toISOString()),
    supa.from("ops_alerts").select("id", { count: "exact", head: true })
      .is("acknowledged_at", null)
      .gte("created_at", ago24h.toISOString()),
    supa.from("ops_alerts").select("id", { count: "exact", head: true })
      .is("acknowledged_at", null)
      .eq("alert_type", "EDCT"),
    supa.from("flights").select("id", { count: "exact", head: true })
      .eq("status", "airborne"),
    supa.from("documents").select("id", { count: "exact", head: true }),
    supa.from("documents").select("id", { count: "exact", head: true })
      .in("status", ["uploaded", "processing"]),
    supa.from("invoice_alerts").select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supa.from("job_applications").select("id", { count: "exact", head: true }),
    supa.from("job_application_parse").select("id", { count: "exact", head: true })
      .eq("needs_review", true),
  ]);

  return {
    flights7d: flights7dRes.count ?? 0,
    flightsToday: flightsTodayRes.count ?? 0,
    activeAlerts24h: activeAlerts24hRes.count ?? 0,
    activeEdcts: activeEdctsRes.count ?? 0,
    airborne: airborneRes.count ?? 0,
    totalInvoices: totalInvoicesRes.count ?? 0,
    invoicesPending: invoicesPendingRes.count ?? 0,
    feeAlertsPending: feeAlertsPendingRes.count ?? 0,
    jobApplications: jobApplicationsRes.count ?? 0,
    jobsNeedReview: jobsNeedReviewRes.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Greeting helper
// ---------------------------------------------------------------------------

function getGreeting(): { greeting: string; dateStr: string } {
  const now = new Date();
  // Convert to ET
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etStr);
  const hour = etDate.getHours();

  let greeting: string;
  if (hour < 12) greeting = "Good morning";
  else if (hour < 17) greeting = "Good afternoon";
  else greeting = "Good evening";

  const dateStr = etDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  return { greeting, dateStr };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StatCard({
  href,
  title,
  subtitle,
  stats,
  iconLetter,
  borderClass,
  iconBgClass,
}: {
  href: string;
  title: string;
  subtitle: string;
  stats?: { label: string; value: number; accent?: string }[];
  iconLetter: string;
  borderClass: string;
  iconBgClass: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-xl border border-l-4 ${borderClass} bg-white p-5 shadow-sm hover:shadow-md transition block`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${iconBgClass}`}>
          {iconLetter}
        </div>
        <div className="min-w-0">
          <div className="text-base font-semibold text-gray-900">{title}</div>
          <div className="text-xs text-gray-500">{subtitle}</div>
        </div>
      </div>
      {stats && stats.length > 0 && (
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-100">
          {stats.map((s) => (
            <div key={s.label}>
              <div className={`text-xl font-bold tabular-nums ${s.accent ?? "text-gray-900"}`}>
                {s.value}
              </div>
              <div className="text-[11px] text-gray-400 leading-tight">{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function HomePage() {
  const stats = await fetchStats().catch(() => null);
  const { greeting, dateStr } = getGreeting();

  return (
    <div className="p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Greeting header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{greeting}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{dateStr}</p>
          {stats && (
            <p className="text-sm text-gray-400 mt-1">
              {stats.flightsToday} flight{stats.flightsToday !== 1 ? "s" : ""} today
              {" · "}
              {stats.activeEdcts} active EDCT{stats.activeEdcts !== 1 ? "s" : ""}
              {" · "}
              {stats.feeAlertsPending} pending alert{stats.feeAlertsPending !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Operations */}
        <div className="space-y-3">
          <SectionLabel>Operations</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              href="/ops"
              title="Operations"
              subtitle="Flight schedule, EDCTs, NOTAMs"
              iconLetter="O"
              borderClass="border-l-blue-500"
              iconBgClass="bg-blue-100 text-blue-700"
              stats={stats ? [
                { label: "Today", value: stats.flightsToday },
                { label: "Next 7 days", value: stats.flights7d },
                { label: "Airborne", value: stats.airborne, accent: stats.airborne > 0 ? "text-green-600" : "text-gray-400" },
                { label: "Active EDCTs", value: stats.activeEdcts, accent: stats.activeEdcts > 0 ? "text-red-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/maintenance"
              title="Maintenance"
              subtitle="Van positioning · overnight aircraft"
              iconLetter="M"
              borderClass="border-l-purple-500"
              iconBgClass="bg-purple-100 text-purple-700"
            />

            <StatCard
              href="/health"
              title="System Health"
              subtitle="Pipeline status and uptime checks"
              iconLetter="H"
              borderClass="border-l-slate-400"
              iconBgClass="bg-slate-100 text-slate-600"
            />
          </div>
        </div>

        {/* Finance */}
        <div className="space-y-3">
          <SectionLabel>Finance</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              href="/invoices"
              title="Invoices"
              subtitle="Browse invoices and open PDFs"
              iconLetter="I"
              borderClass="border-l-indigo-500"
              iconBgClass="bg-indigo-100 text-indigo-700"
              stats={stats ? [
                { label: "Total", value: stats.totalInvoices },
                { label: "Processing", value: stats.invoicesPending, accent: stats.invoicesPending > 0 ? "text-amber-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/alerts"
              title="Fee Alerts"
              subtitle="Actionable fee alerts"
              iconLetter="!"
              borderClass="border-l-amber-500"
              iconBgClass="bg-amber-100 text-amber-700"
              stats={stats ? [
                { label: "Pending", value: stats.feeAlertsPending, accent: stats.feeAlertsPending > 0 ? "text-amber-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/fees"
              title="Fee Comparison"
              subtitle="Highest fees by category and airport"
              iconLetter="$"
              borderClass="border-l-emerald-500"
              iconBgClass="bg-emerald-100 text-emerald-700"
            />
          </div>
        </div>

        {/* People & Tools */}
        <div className="space-y-3">
          <SectionLabel>People & Tools</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              href="/jobs"
              title="Job Applications"
              subtitle="Parsed resumes and candidates"
              iconLetter="J"
              borderClass="border-l-cyan-500"
              iconBgClass="bg-cyan-100 text-cyan-700"
              stats={stats ? [
                { label: "Total", value: stats.jobApplications },
                { label: "Need review", value: stats.jobsNeedReview, accent: stats.jobsNeedReview > 0 ? "text-amber-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/pipeline"
              title="Hiring Pipeline"
              subtitle="Track candidates through hiring stages"
              iconLetter="P"
              borderClass="border-l-violet-500"
              iconBgClass="bg-violet-100 text-violet-700"
            />

            <StatCard
              href="/tanker"
              title="Tanker Planner"
              subtitle="Optimize fuel tankering"
              iconLetter="T"
              borderClass="border-l-orange-500"
              iconBgClass="bg-orange-100 text-orange-700"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
