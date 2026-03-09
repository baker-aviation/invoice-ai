"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_NAV = [
  { href: "/admin/settings", label: "ICS Sources" },
  { href: "/admin/forms", label: "Forms" },
  { href: "/admin/documents", label: "Documents" },
  { href: "/admin/invite", label: "Invite Users" },
  { href: "/admin/users", label: "Manage Users" },
  { href: "/admin/super", label: "Super Admin" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSuper = pathname.startsWith("/admin/super");
  return (
    <div className={`p-6 mx-auto ${isSuper ? "max-w-6xl" : "max-w-4xl"}`}>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Admin</h1>
      <nav className="flex gap-1 mb-6 border-b border-gray-200">
        {ADMIN_NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-2 text-sm font-medium rounded-t-md transition-colors ${
                active
                  ? "text-slate-900 border-b-2 border-slate-900"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
