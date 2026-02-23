import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { fetchAlerts } from "@/lib/invoiceApi";
import { Badge } from "@/components/Badge";

export default async function AlertsPage() {
  const data = await fetchAlerts({ limit: 200 });
  const alerts = data.alerts ?? [];

  return (
    <>
      <Topbar title="Alerts" />

      <div className="p-6 space-y-4">
        <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-100 text-left text-gray-700">
                <tr>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Rule</th>
                  <th className="px-4 py-3 font-medium">Vendor</th>
                  <th className="px-4 py-3 font-medium">Airport</th>
                  <th className="px-4 py-3 font-medium">Tail</th>
                  <th className="px-4 py-3 font-medium">Fee</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>

              <tbody>
                {alerts.map((a: any) => (
                  <tr key={a.id} className="border-t hover:bg-gray-50 transition">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {String(a.created_at ?? "").replace("T", " ").replace("+00:00", "Z")}
                    </td>
                    <td className="px-4 py-3 font-medium">{a.rule_name ?? "—"}</td>
                    <td className="px-4 py-3">{a.vendor ?? "—"}</td>
                    <td className="px-4 py-3">{a.airport_code ?? "—"}</td>
                    <td className="px-4 py-3">{a.tail ?? "—"}</td>
                    <td className="px-4 py-3">
                      {a.fee_name ?? "—"}{" "}
                      {a.fee_amount != null ? (
                        <span className="font-medium">
                          • {a.fee_amount} {a.currency ?? ""}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 space-x-2">
                      <Badge>{a.status ?? "—"}</Badge>
                      <Badge variant={String(a.slack_status).toLowerCase() === "sent" ? "success" : "warning"}>
                        slack: {a.slack_status ?? "—"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link className="text-blue-600 hover:underline" href={`/invoices/${a.document_id}`}>
                        View invoice →
                      </Link>
                    </td>
                  </tr>
                ))}

                {alerts.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                      No alerts found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="text-xs text-gray-500">
          Showing last {alerts.length} alerts.
        </div>
      </div>
    </>
  );
}