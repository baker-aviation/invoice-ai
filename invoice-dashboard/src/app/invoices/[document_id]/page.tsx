import Link from "next/link";
import { fetchInvoiceDetail } from "@/lib/invoiceApi";
import { Topbar } from "@/components/Topbar";
import { Badge } from "@/components/Badge";
import { inferCategory, CATEGORY_COLORS } from "@/lib/invoiceCategory";
import ReparseButton from "./ReparseButton";
import PdfViewer from "./PdfViewer";
import CategorySelect from "./CategorySelect";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ document_id: string }>;
}) {
  const { document_id } = await params;

  let data: Awaited<ReturnType<typeof fetchInvoiceDetail>>;
  try {
    data = await fetchInvoiceDetail(document_id);
  } catch {
    // No parsed invoices yet (likely mid-reparse) — show a processing state
    return (
      <>
        <Topbar title="Invoice detail" />
        <AutoRefresh intervalSeconds={8} />
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Link href="/invoices" className="rounded-md border px-3 py-2 text-sm">
              ← Back to Invoices
            </Link>
            <ReparseButton documentId={document_id} />
            <span className="text-xs text-gray-400 ml-auto">document_id: {document_id}</span>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-amber-800">
            <div className="text-lg font-semibold mb-1">Re-parsing in progress…</div>
            <div className="text-sm">This page will refresh automatically when parsing is complete.</div>
          </div>
        </div>
      </>
    );
  }

  const invoices = data.invoices;
  const isStatement = invoices.length > 1;

  return (
    <>
      <Topbar title="Invoice detail" />

      <div className="p-6 space-y-4">
        {/* Navigation + reparse (shared for the whole document) */}
        <div className="flex items-center gap-3">
          <Link href="/invoices" className="rounded-md border px-3 py-2 text-sm">
            ← Back to Invoices
          </Link>
          <ReparseButton documentId={document_id} />
          <span className="text-xs text-gray-400 ml-auto">document_id: {document_id}</span>
        </div>

        {/* Statement banner */}
        {isStatement && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            This document contains <strong>{invoices.length} invoices</strong>
          </div>
        )}

        {/* PDF viewer (shared across all invoices) */}
        {data.signed_pdf_url && (
          <PdfViewer
            url={data.signed_pdf_url}
            filename={`${invoices[0]?.vendor_name ?? "invoice"} - ${document_id}.pdf`}
          />
        )}

        {/* Render each invoice as a separate section */}
        {invoices.map((invoice: any, idx: number) => {
          const lines = invoice.line_items ?? [];
          const cat = inferCategory(invoice);

          return (
            <div key={invoice.id ?? idx} className="space-y-4">
              {/* Invoice header card */}
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    {isStatement && (
                      <div className="text-xs font-medium text-blue-600 mb-1">
                        Invoice {idx + 1} of {invoices.length}
                      </div>
                    )}
                    <div className="text-lg font-semibold">{invoice.vendor_name ?? "—"}</div>
                    <div className="text-sm text-gray-600">
                      Invoice: {invoice.invoice_number ?? "—"} • Date: {invoice.invoice_date ?? "—"}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {invoice.review_required ? <Badge variant="warning">review</Badge> : <Badge>ok</Badge>}
                    <Badge variant={Number(invoice.risk_score ?? 0) >= 80 ? "danger" : Number(invoice.risk_score ?? 0) >= 50 ? "warning" : "default"}>
                      risk {Number(invoice.risk_score ?? 0)}
                    </Badge>
                  </div>
                </div>

                <div className="mt-4 grid gap-2 md:grid-cols-5 text-sm">
                  <div><span className="text-gray-500">Airport:</span> {invoice.airport_code ?? "—"}</div>
                  <div><span className="text-gray-500">Tail:</span> {invoice.tail_number ?? "—"}</div>
                  <div>
                    <span className="text-gray-500">Category:</span>{" "}
                    <CategorySelect
                      documentId={document_id}
                      invoiceId={invoice.id}
                      currentCategory={cat}
                      categoryOverride={invoice.category_override ?? null}
                    />
                  </div>
                  <div><span className="text-gray-500">Doc type:</span> {invoice.doc_type ?? "—"}</div>
                  <div className="text-right md:text-left">
                    <span className="text-gray-500">Total:</span>{" "}
                    <span className="font-medium">{invoice.total ?? "—"} {invoice.currency ?? ""}</span>
                  </div>
                </div>
              </div>

              {/* Line items table */}
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <div className="font-semibold mb-3">
                  {isStatement ? `Line items — ${invoice.invoice_number ?? `Invoice ${idx + 1}`}` : "Line items"}
                </div>

                {lines.length === 0 ? (
                  <div className="text-sm text-gray-500">No line items</div>
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
                        {lines.map((li: any, liIdx: number) => (
                          <tr key={liIdx} className="border-t">
                            <td className="px-3 py-2">{li.description ?? li.name ?? "—"}</td>
                            <td className="px-3 py-2 text-right">{li.quantity ?? li.qty ?? "—"}</td>
                            <td className="px-3 py-2 text-right">{li.unit_price ?? li.rate ?? "—"}</td>
                            <td className="px-3 py-2 text-right">{li.tax ?? "—"}</td>
                            <td className="px-3 py-2 text-right font-medium">{li.total ?? li.amount ?? li.line_total ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
