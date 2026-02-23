// src/components/AppShell.tsx
import Link from "next/link";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-black">
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="font-semibold">Invoice AI Dashboard</div>

          <nav className="flex gap-4 text-sm">
            <Link className="hover:underline" href="/">
              Invoices
            </Link>
            <Link className="hover:underline" href="/alerts">
              Alerts
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}