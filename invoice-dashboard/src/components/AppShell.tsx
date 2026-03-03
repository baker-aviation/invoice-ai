"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/", label: "Home", exact: true, key: null },
  { href: "/ops", label: "Ops", exact: false, key: "ops" },
  { href: "/invoices", label: "Invoices", exact: false, key: "invoices" },
  { href: "/alerts", label: "Alerts", exact: false, key: "alerts" },
  { href: "/fuel-prices", label: "Fuel Prices", exact: false, key: "fuel-prices" },
  { href: "/jobs", label: "Jobs", exact: false, key: "jobs" },
  { href: "/maintenance", label: "AOG Vans", exact: false, key: "maintenance" },
  { href: "/vehicles", label: "Vehicles", exact: false, key: "vehicles" },
  { href: "/fees", label: "Fees", exact: false, key: "fees" },
  { href: "/settings", label: "Settings", exact: false, key: null },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [allowedTabs, setAllowedTabs] = useState<Set<string> | null>(null);

  // Fetch the user's allowed tabs on mount
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/settings")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.allowed_tabs)) {
          setAllowedTabs(new Set(data.allowed_tabs));
        }
      })
      .catch(() => {
        // On error, show all tabs (fail-open for usability)
      });
    return () => { cancelled = true; };
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Filter nav items by allowed tabs (null key = always visible like Home & Settings)
  const visibleNav = NAV.filter((item) => {
    if (item.key === null) return true; // Home and Settings always visible
    if (allowedTabs === null) return true; // Still loading, show all
    return allowedTabs.has(item.key);
  });

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-slate-900 text-white shadow-md">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <Link href="/" className="font-bold text-white hover:text-slate-200 tracking-tight">
            Baker Aviation
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {visibleNav.map(({ href, label, exact }) => {
              const isActive = exact ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "text-slate-300 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            <button
              onClick={handleSignOut}
              className="ml-3 rounded-md px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}
