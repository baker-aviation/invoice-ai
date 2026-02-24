import Link from "next/link";
import { Topbar } from "@/components/Topbar";

function CardLink({
  href,
  title,
  subtitle,
}: {
  href: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-2xl border bg-white p-6 shadow-sm hover:shadow transition block"
    >
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-gray-600 mt-1">{subtitle}</div>
    </Link>
  );
}

export default function HomePage() {
  return (
    <>
      <Topbar title="Dashboard" />

      <div className="p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="text-sm text-gray-600">Choose a section to view.</div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <CardLink
              href="/invoices"
              title="Invoices"
              subtitle="Browse invoices and open PDFs"
            />

            <CardLink
              href="/alerts"
              title="Alerts"
              subtitle="Actionable fee alerts only"
            />

            <CardLink
              href="/jobs"
              title="Jobs"
              subtitle="Browse parsed job applications"
            />
          </div>
        </div>
      </div>
    </>
  );
}