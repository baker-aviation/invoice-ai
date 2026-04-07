"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// ---------------------------------------------------------------------------
// Two-tier navigation: top-level section pills + sub-tabs
// ---------------------------------------------------------------------------

const PILOT_TABS = [
  { href: "/jobs", label: "Table" },
  { href: "/jobs/pipeline", label: "Pipeline" },
  { href: "/jobs/forecast", label: "Forecast" },
  { href: "/jobs/lors", label: "LORs" },
  { href: "/jobs/rejected", label: "Rejected" },
  { href: "/jobs/admin", label: "Admin" },
] as const;

const GROUND_TABS = [
  { href: "/jobs/ground-table", label: "Table" },
  { href: "/jobs/ground-pipeline", label: "Pipeline" },
  { href: "/jobs/ground-rejected", label: "Rejected" },
  { href: "/jobs/ground-admin", label: "Admin" },
] as const;

const GROUND_PREFIXES = ["/jobs/ground-table", "/jobs/ground-pipeline", "/jobs/ground-rejected", "/jobs/ground-admin"];

function isGroundPath(pathname: string): boolean {
  return GROUND_PREFIXES.some((p) => pathname.startsWith(p));
}

export default function JobsNav() {
  const pathname = usePathname();
  const isGround = isGroundPath(pathname);
  const tabs = isGround ? GROUND_TABS : PILOT_TABS;

  return (
    <div className="space-y-1 px-6 pt-4">
      {/* Top-level section pills */}
      <div className="flex items-center gap-1">
        <Link
          href="/jobs"
          className={`px-4 py-1.5 text-sm font-semibold rounded-full border transition-colors ${
            !isGround
              ? "bg-slate-800 text-white border-slate-800"
              : "text-gray-500 border-gray-200 hover:text-gray-800 hover:border-gray-400 bg-white"
          }`}
        >
          Pilot Jobs
        </Link>
        <Link
          href="/jobs/ground-table"
          className={`px-4 py-1.5 text-sm font-semibold rounded-full border transition-colors ${
            isGround
              ? "bg-teal-700 text-white border-teal-700"
              : "text-gray-500 border-gray-200 hover:text-gray-800 hover:border-gray-400 bg-white"
          }`}
        >
          Ground Jobs
        </Link>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-1">
        {tabs.map((tab) => {
          const active =
            tab.href === "/jobs"
              ? pathname === "/jobs"
              : tab.href === "/jobs/ground-table"
                ? pathname === "/jobs/ground-table"
                : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                active
                  ? isGround
                    ? "bg-teal-100 text-teal-800"
                    : "bg-slate-800 text-white"
                  : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
