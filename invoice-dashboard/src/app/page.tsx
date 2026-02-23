import Link from "next/link";
import { fetchInvoices } from "@/lib/invoiceApi";
import { Topbar } from "@/components/Topbar";

export default async function Home() {
  const data = await fetchInvoices(100);
  const invoices = data.invoices ?? [];

  return (
    <>
      <Topbar title="Invoices" />

      <div className="p-6">
        <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-100 text-left text-gray-700">
                <tr>
                  <th className="px-4 py-3 font-medium">Vendor</th>
                  <th className="px-4 py-3 font-medium">Invoice #</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Airport</th>
                  <th className="px-4 py-3 font-medium">Tail</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>

              <tbody>
                {invoices.map((inv: any) => (
                  <tr
                    key={inv.document_id}
                    className="border-t hover:bg-gray-50 transition"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        {inv.vendor_name ?? "—"}
                      </div>
                      <div className="text-xs text-gray-500">
                        {inv.doc_type ?? "unknown"}
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      {inv.invoice_number ?? "—"}
                    </td>

                    <td className="px-4 py-3">
                      {inv.invoice_date ?? "—"}
                    </td>

                    <td className="px-4 py-3">
                      {inv.airport_code ?? "—"}
                    </td>

                    <td className="px-4 py-3">
                      {inv.tail_number ?? "—"}
                    </td>

                    <td className="px-4 py-3 text-right font-medium">
                      {inv.total ?? "—"}{" "}
                      <span className="text-gray-500 text-xs">
                        {inv.currency ?? ""}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/invoices/${inv.document_id}`}
                        className="text-blue-600 hover:underline text-sm"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}

                {invoices.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-gray-500"
                    >
                      No invoices found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}