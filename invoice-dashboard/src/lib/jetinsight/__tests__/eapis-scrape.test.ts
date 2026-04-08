import { describe, it, expect, vi, beforeEach } from "vitest";
import { scrapeEapisStatus } from "../trip-sync";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock supabase service client (trip-sync imports it at module level)
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({}),
}));

function htmlPage(body: string) {
  return `<html><body>${body}</body></html>`;
}

function mockResponse(html: string, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(html),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("scrapeEapisStatus", () => {
  it("returns empty array on 404", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([]);
  });

  it("returns empty array on 422", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([]);
  });

  it("throws on other HTTP errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(scrapeEapisStatus("trip123", "cookie=abc")).rejects.toThrow(
      "eAPIS page HTTP 500",
    );
  });

  it("Strategy 1: parses DEPART/ARRIVE segment blocks", async () => {
    const html = htmlPage(`
      <div class="segment">
        <span>DEPART KOPF</span>
        <span>ARRIVE TAPA</span>
        <span class="text-success">Approved</span>
      </div>
      <div class="segment">
        <span>DEPART TAPA</span>
        <span>ARRIVE MYAM</span>
        <span class="text-warning">Pending</span>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "KOPF", arr_icao: "TAPA", status: "approved", provider: "us" },
      { dep_icao: "TAPA", arr_icao: "MYAM", status: "pending", provider: "us" },
    ]);
  });

  it("Strategy 1: detects CARICOM provider", async () => {
    const html = htmlPage(`
      <div class="segment">
        <span>DEPART TAPA</span>
        <span>ARRIVE MYAM</span>
        <span>CARICOM: Approved</span>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "TAPA", arr_icao: "MYAM", status: "approved", provider: "caricom" },
    ]);
  });

  it("Strategy 1: deduplicates same leg", async () => {
    const html = htmlPage(`
      <div class="segment">
        <span>DEPART KOPF</span>
        <span>ARRIVE TAPA</span>
        <span class="text-success">Approved</span>
      </div>
      <div class="card">
        <span>DEPART KOPF</span>
        <span>ARRIVE TAPA</span>
        <span class="text-success">Approved</span>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toHaveLength(1);
  });

  it("Strategy 1: handles not_filed status (no status markers)", async () => {
    const html = htmlPage(`
      <div class="segment">
        <span>DEPART KOPF</span>
        <span>ARRIVE MMSL</span>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "KOPF", arr_icao: "MMSL", status: "not_filed", provider: "us" },
    ]);
  });

  it("Strategy 2: parses arrow route patterns when no DEPART/ARRIVE found", async () => {
    const html = htmlPage(`
      <div>
        <p>KOPF → TAPA — US: Approved</p>
        <p>TAPA → MYAM — CARICOM: Pending</p>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "KOPF", arr_icao: "TAPA", status: "approved", provider: "us" },
      { dep_icao: "TAPA", arr_icao: "MYAM", status: "pending", provider: "caricom" },
    ]);
  });

  it("Strategy 2: parses 'to' route patterns", async () => {
    const html = htmlPage(`
      <span>KOPF to MMSL approved</span>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "KOPF", arr_icao: "MMSL", status: "approved", provider: "us" },
    ]);
  });

  it("Strategy 2: parses dash-arrow route patterns", async () => {
    const html = htmlPage(`
      <div>KOPF -> TAPA pending</div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "KOPF", arr_icao: "TAPA", status: "pending", provider: "us" },
    ]);
  });

  it("returns empty for page with no recognizable patterns", async () => {
    const html = htmlPage(`<div>No eAPIS data available for this trip.</div>`);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([]);
  });

  it("passes correct URL and headers", async () => {
    mockResponse(htmlPage(""));
    await scrapeEapisStatus("trip456", "session=xyz");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://portal.jetinsight.com/trips/trip456/eapis",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Cookie: "session=xyz",
        }),
      }),
    );
  });

  it("handles 3-char IATA codes in DEPART/ARRIVE", async () => {
    const html = htmlPage(`
      <div class="segment">
        <span>DEPART OPF</span>
        <span>ARRIVE NAS</span>
        <span class="text-success">Approved</span>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "OPF", arr_icao: "NAS", status: "approved", provider: "us" },
    ]);
  });

  it("handles US: and CARICOM: provider labels in same page", async () => {
    const html = htmlPage(`
      <div class="segment">
        <span>DEPART KOPF</span>
        <span>ARRIVE TAPA</span>
        <span>US: Approved</span>
      </div>
      <div class="segment">
        <span>DEPART TAPA</span>
        <span>ARRIVE TBPB</span>
        <span>CARICOM: Pending</span>
      </div>
    `);
    mockResponse(html);
    const result = await scrapeEapisStatus("trip123", "cookie=abc");
    expect(result).toEqual([
      { dep_icao: "KOPF", arr_icao: "TAPA", status: "approved", provider: "us" },
      { dep_icao: "TAPA", arr_icao: "TBPB", status: "pending", provider: "caricom" },
    ]);
  });
});
