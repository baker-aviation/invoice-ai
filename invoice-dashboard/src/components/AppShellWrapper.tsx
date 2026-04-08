"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Image from "next/image";
import { AppShell } from "@/components/AppShell";
import { BugReportButton } from "@/components/BugReportButton";
import { createClient } from "@/lib/supabase/client";

function MinimalShell({ children, title }: { children: React.ReactNode; title: string }) {
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
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Image src="/logo3.png" alt="Baker Aviation" width={150} height={47} priority />
            <span className="text-sm font-medium text-slate-300">{title}</span>
          </div>
          <button
            onClick={handleSignOut}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}

export function AppShellWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setRole(user?.app_metadata?.role ?? user?.user_metadata?.role ?? null);
      setLoaded(true);
    });
  }, []);

  // Pilot portal and login have their own layouts — skip the dashboard AppShell
  // Note: /pilot/* is the pilot portal, /pilots/* is the admin view (needs AppShell)
  if ((pathname.startsWith("/pilot") && !pathname.startsWith("/pilots")) || pathname.startsWith("/login") || pathname === "/invite" || pathname.startsWith("/form")) {
    return <>{children}</>;
  }

  // Chief pilot gets a minimal shell
  if (loaded && role === "chief_pilot") {
    return (
      <>
        <MinimalShell title="Interview Review">{children}</MinimalShell>
        <BugReportButton />
      </>
    );
  }

  return (
    <>
      <AppShell>{children}</AppShell>
      <BugReportButton />
    </>
  );
}
