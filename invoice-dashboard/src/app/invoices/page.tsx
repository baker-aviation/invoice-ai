export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { fetchInvoices } from "@/lib/invoiceApi";
import InvoicesTable from "./InvoicesTable";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function InvoicesPage() {
  const data = await fetchInvoices({ limit: 200 });
  const invoices = data.invoices ?? [];

  return (
    <>
      <Topbar title="Invoices" />
      <AutoRefresh intervalSeconds={120} />
      <InvoicesTable initialInvoices={invoices} />
    </>
  );
}