"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const PILOT_NAV = [
  { href: "/pilot", label: "Home", exact: true },
  { href: "/pilot/bulletins", label: "Bulletins", exact: false },
  { href: "/pilot/chat", label: "Aircraft Chat", exact: false },
  { href: "/pilot/documents", label: "Documents", exact: false },
  { href: "/pilot/tanker", label: "Tanker Planner", exact: false },
  { href: "/pilot/training", label: "Training", exact: false },
  { href: "/pilot/logbook", label: "Logbook", exact: false },
  { href: "/pilot/time-off", label: "Time Off", exact: false },
  { href: "/pilot/schedule", label: "My Schedule", exact: false },
];

export function PilotShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      const role = user?.app_metadata?.role ?? user?.user_metadata?.role;
      setIsAdmin(role === "admin");
    });
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {isAdmin && (
        <div className="bg-amber-400 text-amber-900 px-4 sm:px-6 py-2 flex items-center justify-between text-sm font-medium">
          <span>Viewing as Pilot</span>
          <button
            onClick={() => router.push("/")}
            className="rounded-md bg-amber-600 px-3 py-1 text-white hover:bg-amber-700 transition-colors"
          >
            Exit Pilot View
          </button>
        </div>
      )}
      <header className="bg-slate-900 text-white shadow-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <Link href="/pilot" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
            <Image src="/logo3.png" alt="Baker Aviation" width={120} height={38} priority />
            <span className="font-medium text-blue-200 text-sm">Pilot Portal</span>
          </Link>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-2 rounded-md hover:bg-white/10 transition-colors"
            aria-label="Toggle menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1 text-sm">
            {PILOT_NAV.map(({ href, label, exact }) => {
              const isActive = exact ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "text-blue-200 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            <button
              onClick={handleSignOut}
              className="ml-3 rounded-md px-3 py-1.5 text-sm font-medium text-blue-200 hover:bg-white/10 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>

        {/* Mobile nav dropdown */}
        {menuOpen && (
          <nav className="md:hidden border-t border-blue-800 px-4 pb-3 pt-2 flex flex-col gap-1">
            {PILOT_NAV.map(({ href, label, exact }) => {
              const isActive = exact ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "text-blue-200 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            <button
              onClick={handleSignOut}
              className="mt-1 rounded-md px-3 py-2 text-sm font-medium text-left text-blue-200 hover:bg-white/10 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-4 sm:py-6">{children}</main>
    </div>
  );
}
