"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/jobs", label: "Table" },
  { href: "/jobs/pipeline", label: "Pipeline" },
] as const;

export default function JobsNav() {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-1 px-6 pt-4">
      {TABS.map((tab) => {
        const active =
          tab.href === "/jobs"
            ? pathname === "/jobs"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              active
                ? "bg-slate-800 text-white"
                : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
