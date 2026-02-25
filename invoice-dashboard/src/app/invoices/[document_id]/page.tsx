import Link from "next/link";
import { fetchInvoiceDetail } from "@/lib/invoiceApi";
import { Topbar } from "@/components/Topbar";
import { Badge } from "@/components/Badge";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ document_id: string }>;
}) {
  const { document_id } = await params;

  const data = await fetchInvoiceDetail(document_id);
  const invoice = data.invoice;
  const lines = invoice?.line_items ?? [];

  // Server-side safe env var
  const base = (process.env.INVOICE_API_BASE_URL || "").replace(/\/$/, "");
  const fileUrl = base
    ? `${base}/api/invoices/${document_id}/file`
    : "";

  return (
    <>
      <Topbar title="Invoice detail" />

      <div className="p-6 space-y-4">
        {/* Header Card */}
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">
                {invoice.vendor_name ?? "—"}
              </div>
              <div className="text-sm text-gray-600">
                Invoice: {invoice.invoice_number ?? "—"} • Date:{" "}
                {invoice.invoice_date ?? "—"}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                document_id: {document_id}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {invoice.review_required ? (
                <Badge variant="warning">review</Badge>
              ) : (
                <Badge>ok</Badge>
              )}

              <Badge
                variant={
                  Number(invoice.risk_score ?? 0) >= 80
                    ? "danger"
                    : Number(invoice.risk_score ?? 0) >= 50
                    ? "warning"
                    : "default"
                }
              >
                risk {Number(invoice.risk_score ?? 0)}
              </Badge>
            </div>
          </div>

          {/* Summary Grid */}
          <div className="mt-4 grid gap-2 md:grid-cols-4 text-sm">
            <div>
              <span className="text-gray-500">Airport:</span>{" "}
              {invoice.airport_code ?? "—"}
            </div>
            <div>
              <span className="text-gray-500">Tail:</span>{" "}
              {invoice.tail_number ?? "—"}
            </div>
            <div>
              <span className="text-gray-500">Doc type:</span>{" "}
              {invoice.doc_type ?? "—"}
            </div>
            <div className="text-right md:text-left">
              <span className="text-gray-500">Total:</span>{" "}
              <span className="font-medium">
                {invoice.total ?? "—"} {invoice.currency ?? ""}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-4 flex gap-3">
            {fileUrl ? (
              <a
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Open PDF
              </a>
            ) : (
              <span className="text-sm text-red-600">
                Missing INVOICE_API_BASE_URL
              </span>
            )}

            <Link
              href="/invoices"
              className="rounded-md border px-3 py-2 text-sm"
            >
              ← Back
            </Link>
          </div>
        </div>

        {/* Line Items */}
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="font-semibold mb-3">Line items</div>

          {lines.length === 0 ? (
            <div className="text-sm text-gray-500">
              No line items
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 text-left text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Unit</th>
                    <th className="px-3 py-2 text-right">Tax</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((li: any, idx: number) => (
                    <tr key={idx} className="border-t">
                      <td className="px-3 py-2">
                        {li.description ?? li.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {li.quantity ?? li.qty ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {li.unit_price ?? li.rate ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {li.tax ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        {li.total ??
                          li.amount ??
                          li.line_total ??
                          "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}