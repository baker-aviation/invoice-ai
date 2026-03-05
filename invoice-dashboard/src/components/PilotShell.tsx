"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const PILOT_NAV = [
  { href: "/pilot", label: "Home", exact: true },
  { href: "/pilot/chat", label: "Aircraft Chat", exact: false },
  { href: "/pilot/documents", label: "Documents", exact: false },
  { href: "/pilot/tanker", label: "Tanker Planner", exact: false },
];

export function PilotShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      const role = user?.app_metadata?.role ?? user?.user_metadata?.role;
      setIsAdmin(role === "admin");
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
      {isAdmin && (
        <div className="bg-amber-400 text-amber-900 px-6 py-2 flex items-center justify-between text-sm font-medium">
          <span>Viewing as Pilot</span>
          <button
            onClick={() => router.push("/")}
            className="rounded-md bg-amber-600 px-3 py-1 text-white hover:bg-amber-700 transition-colors"
          >
            Exit Pilot View
          </button>
        </div>
      )}
      <header className="bg-blue-900 text-white shadow-md">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <Link href="/pilot" className="font-bold text-white hover:text-blue-200 tracking-tight">
            Baker Aviation — Pilot Portal
          </Link>

          <nav className="flex items-center gap-1 text-sm">
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
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}
