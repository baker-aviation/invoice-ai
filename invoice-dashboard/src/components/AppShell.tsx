"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const NAV = [
  { href: "/", label: "Home", exact: true },
  { href: "/ops", label: "Ops", exact: false },
  { href: "/invoices", label: "Invoices", exact: false },
  { href: "/alerts", label: "Alerts", exact: false },
  { href: "/jobs", label: "Jobs", exact: false },
  { href: "/maintenance", label: "AOG Vans", exact: false },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-slate-900 text-white shadow-md">
        <div className="mx-auto max-w-6xl px-6 py-3 flex items-center justify-between">
          <Link href="/" className="font-bold text-white hover:text-slate-200 tracking-tight">
            Baker Aviation
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {NAV.map(({ href, label, exact }) => {
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

      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
