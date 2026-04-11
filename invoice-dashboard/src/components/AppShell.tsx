"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hasAccessToPath } from "@/lib/permissions";

const NAV = [
  { href: "/", label: "Home", exact: true, adminOnly: false, superAdminOnly: false },
  { href: "/ops", label: "Ops", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/invoices", label: "Invoices", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/fuel-prices", label: "Fuel / Fees", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/jobs", label: "Jobs", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/maintenance", label: "AOG Vans", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/vehicles", label: "Vehicles", exact: false, adminOnly: false, superAdminOnly: false },
  // { href: "/fees", label: "Fees", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/foreflight", label: "Fuel Planning", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/pilots", label: "Pilots", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/aircraft", label: "Aircraft", exact: false, adminOnly: false, superAdminOnly: false },
  { href: "/hamilton", label: "Hamilton", exact: false, adminOnly: true, superAdminOnly: false },
  { href: "/jetinsight", label: "JetInsight", exact: false, adminOnly: true, superAdminOnly: false },
  { href: "/health", label: "Health", exact: false, adminOnly: false, superAdminOnly: true },
  { href: "/admin/settings", label: "Admin", exact: false, adminOnly: true, superAdminOnly: false },
];

const ROLE_VIEWS = [
  { role: "pilot", label: "Pilot", href: "/pilot" },
  { role: "chief_pilot", label: "Chief Pilot", href: "/jobs/chief-pilot" },
  { role: "mx", label: "MX", href: "/maintenance" },
  { role: "van", label: "Van Driver", href: "/van/1" },
] as const;

function RoleEmulator() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="relative ml-3">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-md px-3 py-1.5 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors flex items-center gap-1.5"
      >
        View as...
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d={open ? "M2 6l3-3 3 3" : "M2 4l3 3 3-3"} />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-gray-200 bg-white shadow-lg py-1 z-50">
          {ROLE_VIEWS.map(({ role, label, href }) => (
            <button
              key={role}
              onClick={() => {
                setOpen(false);
                router.push(href);
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              {label}
            </button>
          ))}
          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false);
                router.push("/");
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              Back to Admin
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [permissions, setPermissions] = useState<string[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      const role = user?.app_metadata?.role ?? user?.user_metadata?.role;
      setIsAdmin(role === "admin");
      setIsSuperAdmin(user?.app_metadata?.super_admin === true);
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
            {NAV.filter(({ href, adminOnly, superAdminOnly }) => superAdminOnly ? isSuperAdmin : adminOnly ? isAdmin : (isAdmin || hasAccessToPath(permissions, href))).map(({ href, label, exact }) => {
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
            {isAdmin && <RoleEmulator />}
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
