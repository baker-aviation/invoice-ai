import { AlertsResponse, InvoiceDetailResponse, InvoiceListResponse } from "@/lib/types";

const BASE = process.env.INVOICE_API_BASE_URL;

function mustBase(): string {
  if (!BASE) throw new Error("Missing INVOICE_API_BASE_URL in .env.local");
  return BASE.replace(/\/$/, "");
}

export async function fetchInvoices(params: {
  limit?: number;
  q?: string;
  vendor?: string;
  doc_type?: string;
  airport?: string;
  tail?: string;
  review_required?: "true" | "false";
  min_risk?: number;
} = {}): Promise<InvoiceListResponse> {
  const base = mustBase();
  const url = new URL(`${base}/api/invoices`);

  url.searchParams.set("limit", String(params.limit ?? 100));
  if (params.q) url.searchParams.set("q", params.q);
  if (params.vendor) url.searchParams.set("vendor", params.vendor);
  if (params.doc_type) url.searchParams.set("doc_type", params.doc_type);
  if (params.airport) url.searchParams.set("airport", params.airport);
  if (params.tail) url.searchParams.set("tail", params.tail);
  if (params.review_required) url.searchParams.set("review_required", params.review_required);
  if (typeof params.min_risk === "number") url.searchParams.set("min_risk", String(params.min_risk));

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`fetchInvoices failed: ${res.status}`);
  return res.json();
}

export async function fetchInvoiceDetail(documentId: string): Promise<InvoiceDetailResponse> {
  const base = mustBase();
  const res = await fetch(`${base}/api/invoices/${documentId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetchInvoiceDetail failed: ${res.status}`);
  return res.json();
}

export async function fetchAlerts(params: {
  limit?: number;
  q?: string;
  status?: string;
  slack_status?: string;
} = {}): Promise<AlertsResponse> {
  const base = mustBase();
  const url = new URL(`${base}/api/alerts`);
  url.searchParams.set("limit", String(params.limit ?? 100));
  if (params.q) url.searchParams.set("q", params.q);
  if (params.status) url.searchParams.set("status", params.status);
  if (params.slack_status) url.searchParams.set("slack_status", params.slack_status);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`fetchAlerts failed: ${res.status}`);
  return res.json();
}