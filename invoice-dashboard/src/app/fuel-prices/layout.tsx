"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SUB_TABS = [
  { href: "/fuel-prices", label: "Fuel Prices", exact: true },
  { href: "/fuel-prices/fbos", label: "FBOs", exact: true },
  { href: "/fuel-prices/fbos/outreach", label: "Outreach", exact: false },
];

export default function FuelPricesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <>
      <div className="flex items-center gap-6 mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Fuel / Fees</h1>
        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {SUB_TABS.map(({ href, label, exact }) => {
            const isActive = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  isActive
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
      {children}
    </>
  );
}
