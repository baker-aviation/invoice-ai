export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Topbar } from "@/components/Topbar";
import { fetchInvoices, fetchAlerts, fetchAlertRules } from "@/lib/invoiceApi";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import InvoicesTabs from "./InvoicesTabs";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  // Fetch invoices, alerts, and rules in parallel
  const [invoiceData, alertData, rules] = await Promise.all([
    fetchInvoices({ limit: 1000 }),
    fetchAlerts({ limit: 1000 }),
    fetchAlertRules(),
  ]);

  const invoices = invoiceData.invoices ?? [];
  const alerts = alertData.alerts ?? [];

  // Batch-sign PDF URLs for alerts
  const docIds = [...new Set(alerts.map((a) => a.document_id).filter(Boolean))];
  const pdfUrls: Record<string, string> = {};

  if (docIds.length > 0) {
    const supa = createServiceClient();
    const { data: docs } = await supa
      .from("documents")
      .select("id, gcs_bucket, gcs_path")
      .in("id", docIds);

    await Promise.all(
      (docs ?? []).map(async (doc) => {
        if (doc.gcs_bucket && doc.gcs_path) {
          const url = await signGcsUrl(doc.gcs_bucket as string, doc.gcs_path as string);
          if (url) pdfUrls[doc.id as string] = url;
        }
      }),
    );
  }

  return (
    <>
      <Topbar title="Invoices" />
      <AutoRefresh intervalSeconds={120} />
      <InvoicesTabs invoices={invoices} alerts={alerts} pdfUrls={pdfUrls} rules={rules} initialTab={tab} />
    </>
  );
}
