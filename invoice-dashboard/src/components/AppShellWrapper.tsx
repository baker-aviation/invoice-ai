"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@/components/AppShell";

export function AppShellWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Pilot portal and login have their own layouts — skip the dashboard AppShell
  // Note: /pilot/* is the pilot portal, /pilots/* is the admin view (needs AppShell)
  if ((pathname.startsWith("/pilot") && !pathname.startsWith("/pilots")) || pathname.startsWith("/login") || pathname === "/invite" || pathname.startsWith("/form")) {
    return <>{children}</>;
  }

  return <AppShell>{children}</AppShell>;
}
