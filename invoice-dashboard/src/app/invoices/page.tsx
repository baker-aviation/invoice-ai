import { Topbar } from "@/components/Topbar";
import { fetchInvoices } from "@/lib/invoiceApi";
import InvoicesTable from "./InvoicesTable";

export default async function InvoicesPage() {
  const data = await fetchInvoices({ limit: 200 });
  const invoices = data.invoices ?? [];

  return (
    <>
      <Topbar title="Invoices" />
      <InvoicesTable initialInvoices={invoices} />
    </>
  );
}