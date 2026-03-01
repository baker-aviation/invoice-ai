export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchAlerts } from "@/lib/invoiceApi";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import AlertsTable from "./AlertsTable";

export default async function AlertsPage() {
  const data = await fetchAlerts({ limit: 200 });
  const alerts = data.alerts ?? [];

  // Batch-sign PDF URLs for all unique document_ids
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
      <Topbar title="Alerts" />
      <AutoRefresh intervalSeconds={120} />
      <AlertsTable initialAlerts={alerts} pdfUrls={pdfUrls} />
    </>
  );
}
