import Link from "next/link";

type NavItem = { href: string; label: string };

const nav: NavItem[] = [
  { href: "/", label: "Invoices" },
  { href: "/alerts", label: "Alerts" },
];

export function Sidebar() {
  return (
    <aside className="hidden md:flex md:w-64 md:flex-col md:border-r md:bg-white">
      <div className="px-5 py-4 border-b">
        <div className="text-lg font-semibold">Invoice AI</div>
        <div className="text-sm text-gray-500">Internal dashboard</div>
      </div>

      <nav className="flex-1 px-3 py-3">
        <ul className="space-y-1">
          {nav.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="block rounded-md px-3 py-2 text-sm hover:bg-gray-100"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-5 py-4 border-t text-xs text-gray-500">
        v0.1 • Next.js
      </div>
    </aside>
  );
}