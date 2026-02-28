export const dynamic = "force-dynamic";

import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { createServiceClient } from "@/lib/supabase/service";

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

type DashboardStats = {
  flights7d: number;
  flightsToday: number;
  activeAlerts: number;
  criticalAlerts: number;
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

  const [
    flights7dRes,
    flightsTodayRes,
    activeAlertsRes,
    criticalAlertsRes,
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
      .is("acknowledged_at", null),
    supa.from("ops_alerts").select("id", { count: "exact", head: true })
      .is("acknowledged_at", null)
      .eq("severity", "critical"),
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
    activeAlerts: activeAlertsRes.count ?? 0,
    criticalAlerts: criticalAlertsRes.count ?? 0,
    totalInvoices: totalInvoicesRes.count ?? 0,
    invoicesPending: invoicesPendingRes.count ?? 0,
    feeAlertsPending: feeAlertsPendingRes.count ?? 0,
    jobApplications: jobApplicationsRes.count ?? 0,
    jobsNeedReview: jobsNeedReviewRes.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StatCard({
  href,
  title,
  subtitle,
  stats,
}: {
  href: string;
  title: string;
  subtitle: string;
  stats?: { label: string; value: number; accent?: string }[];
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border bg-white p-5 shadow-sm hover:shadow transition block"
    >
      <div className="text-base font-semibold text-gray-900">{title}</div>
      <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function HomePage() {
  const stats = await fetchStats().catch(() => null);

  return (
    <>
      <Topbar title="Dashboard" />

      <div className="p-4 sm:p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              href="/ops"
              title="Operations"
              subtitle="Flight schedule, EDCTs, NOTAMs"
              stats={stats ? [
                { label: "Today", value: stats.flightsToday },
                { label: "Next 7 days", value: stats.flights7d },
                { label: "Active alerts", value: stats.activeAlerts, accent: stats.criticalAlerts > 0 ? "text-red-600" : stats.activeAlerts > 0 ? "text-amber-600" : "text-gray-400" },
                ...(stats.criticalAlerts > 0 ? [{ label: "Critical", value: stats.criticalAlerts, accent: "text-red-600" }] : []),
              ] : undefined}
            />

            <StatCard
              href="/invoices"
              title="Invoices"
              subtitle="Browse invoices and open PDFs"
              stats={stats ? [
                { label: "Total", value: stats.totalInvoices },
                { label: "Processing", value: stats.invoicesPending, accent: stats.invoicesPending > 0 ? "text-amber-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/alerts"
              title="Fee Alerts"
              subtitle="Actionable fee alerts"
              stats={stats ? [
                { label: "Pending", value: stats.feeAlertsPending, accent: stats.feeAlertsPending > 0 ? "text-amber-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/jobs"
              title="Job Applications"
              subtitle="Parsed resumes and candidates"
              stats={stats ? [
                { label: "Total", value: stats.jobApplications },
                { label: "Need review", value: stats.jobsNeedReview, accent: stats.jobsNeedReview > 0 ? "text-amber-600" : "text-gray-400" },
              ] : undefined}
            />

            <StatCard
              href="/maintenance"
              title="Maintenance"
              subtitle="Van positioning · overnight aircraft"
            />

            <StatCard
              href="/tanker"
              title="Tanker Planner"
              subtitle="Optimize fuel tankering"
            />
          </div>
        </div>
      </div>
    </>
  );
}
