"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hasAccessToPath } from "@/lib/permissions";

const NAV = [
  { href: "/", label: "Home", exact: true, adminOnly: false },
  { href: "/ops", label: "Ops", exact: false, adminOnly: false },
  { href: "/invoices", label: "Invoices", exact: false, adminOnly: false },
  { href: "/alerts", label: "Alerts", exact: false, adminOnly: false },
  { href: "/fuel-prices", label: "Fuel / Fees", exact: false, adminOnly: false },
  { href: "/jobs", label: "Jobs", exact: false, adminOnly: false },
  { href: "/maintenance", label: "AOG Vans", exact: false, adminOnly: false },
  { href: "/vehicles", label: "Vehicles", exact: false, adminOnly: false },
  // { href: "/fees", label: "Fees", exact: false, adminOnly: false },
  { href: "/foreflight", label: "Fuel Planning", exact: false, adminOnly: false },
  { href: "/pilots", label: "Pilots", exact: false, adminOnly: false },
  { href: "/health", label: "Health", exact: false, adminOnly: true },
  { href: "/admin/settings", label: "Admin", exact: false, adminOnly: true },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [permissions, setPermissions] = useState<string[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      const role = user?.app_metadata?.role ?? user?.user_metadata?.role;
      setIsAdmin(role === "admin");
      if (role === "dashboard") {
        setPermissions((user?.app_metadata?.permissions as string[] | undefined) ?? null);
      }
    });
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-slate-900 text-white shadow-md">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center hover:opacity-90 transition-opacity">
            <Image src="/logo3.png" alt="Baker Aviation" width={150} height={47} priority />
          </Link>

          <nav className="flex items-center gap-0.5 text-sm">
            {NAV.filter(({ href, adminOnly }) => adminOnly ? isAdmin : (isAdmin || hasAccessToPath(permissions, href))).map(({ href, label, exact }) => {
              const isActive = exact ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`whitespace-nowrap rounded-md px-2.5 py-1.5 font-medium transition-colors ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "text-slate-300 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            {isAdmin && (
              <button
                onClick={() => router.push("/pilot")}
                className="ml-3 rounded-md px-3 py-1.5 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                View as Pilot
              </button>
            )}
            <button
              onClick={handleSignOut}
              className="ml-3 rounded-md px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className={`mx-auto px-6 py-6 ${
        pathname.startsWith("/fuel-prices") ? "max-w-[1600px]" : "max-w-7xl"
      }`}>{children}</main>
    </div>
  );
}
