"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Topbar } from "@/components/Topbar";

const SUBTABS = [
  { href: "/integrations", label: "Overview", match: (p: string) => p === "/integrations" },
  { href: "/integrations/hamilton", label: "Hamilton", match: (p: string) => p.startsWith("/integrations/hamilton") },
  { href: "/integrations/jetinsight", label: "JetInsight", match: (p: string) => p.startsWith("/integrations/jetinsight") },
  { href: "/integrations/hasdata", label: "HasData", match: (p: string) => p.startsWith("/integrations/hasdata") },
];

export default function IntegrationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  return (
    <>
      <Topbar title="Integrations" />
      <div className="px-6 -mt-2">
        <nav className="mb-4 flex gap-6 border-b border-slate-200">
          {SUBTABS.map((tab) => {
            const active = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={
                  "pb-2 text-sm font-medium transition-colors " +
                  (active
                    ? "border-b-2 border-slate-900 text-slate-900"
                    : "text-slate-500 hover:text-slate-700")
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </>
  );
}
