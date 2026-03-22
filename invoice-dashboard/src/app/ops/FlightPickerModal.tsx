"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

type TransportOption = {
  type: "commercial" | "uber" | "rental_car" | "drive" | "train";
  flight_number: string | null;
  origin_iata: string;
  destination_iata: string | null;
  depart_at: string | null;
  arrive_at: string | null;
  fbo_arrive_at: string | null;
  duty_on_at: string | null;
  cost_estimate: number;
  duration_minutes: number | null;
  is_direct: boolean;
  connection_count: number;
  has_backup: boolean;
  backup_flight: string | null;
  score: number;
  feasibility: {
    duty_hours: number | null;
    duty_ok: boolean;
    fbo_buffer_min: number | null;
    fbo_buffer_ok: boolean;
    midnight_ok: boolean;
  };
  _isLive?: boolean; // added by live search
};

type TransportOptionsResponse = {
  crew: { id: string; name: string; role: string; home_airports: string[] };
  destination: { icao: string; iata: string };
  direction: "oncoming" | "offgoing";
  options: TransportOption[];
  total: number;
};

export type FlightPickerSelection = {
  type: "commercial" | "uber" | "rental_car" | "drive" | "train";
  flight_number: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  travel_from: string | null;
  travel_to: string | null;
  cost_estimate: number;
  duration_minutes: number | null;
  available_time: string | null;
  duty_on_time: string | null;
  backup_flight: string | null;
};

export type FlightPickerProps = {
  crewMemberId: string;
  crewName: string;
  crewRole: "PIC" | "SIC";
  homeAirports: string[];
  destinationIcao: string;
  swapDate: string;
  direction: "oncoming" | "offgoing";
  tailNumber: string;
  firstLegDep?: string | null;
  lastLegArr?: string | null;
  onSelect: (selection: FlightPickerSelection) => void;
  onClose: () => void;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(min: number | null): string {
  if (min == null) return "--";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
}

function typeLabel(type: string): string {
  switch (type) {
    case "commercial": return "Flight";
    case "uber": return "Uber";
    case "rental_car": return "Rental";
    case "drive": return "Drive";
    case "train": return "Train";
    default: return type;
  }
}

function typeColor(type: string): string {
  switch (type) {
    case "commercial": return "text-blue-700 bg-blue-50";
    case "uber": return "text-violet-700 bg-violet-50";
    case "rental_car": return "text-orange-700 bg-orange-50";
    case "drive": return "text-amber-700 bg-amber-50";
    case "train": return "text-teal-700 bg-teal-50";
    default: return "text-gray-700 bg-gray-50";
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function FlightPickerModal({
  crewMemberId,
  crewName,
  crewRole,
  homeAirports,
  destinationIcao,
  swapDate,
  direction,
  tailNumber,
  firstLegDep,
  lastLegArr,
  onSelect,
  onClose,
}: FlightPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TransportOptionsResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [liveResults, setLiveResults] = useState<TransportOption[]>([]);

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        crew_member_id: crewMemberId,
        destination_icao: destinationIcao,
        swap_date: swapDate,
        direction,
      });
      if (firstLegDep) params.set("first_leg_dep", firstLegDep);
      if (lastLegArr) params.set("last_leg_arr", lastLegArr);

      const res = await fetch(`/api/crew/transport-options?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load options");
    } finally {
      setLoading(false);
    }
  }, [crewMemberId, destinationIcao, swapDate, direction, firstLegDep, lastLegArr]);

  useEffect(() => { fetchOptions(); }, [fetchOptions]);

  // Live flight search
  const searchMoreFlights = async () => {
    if (searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      // Search from each home airport to the destination
      for (const home of homeAirports) {
        const homeIata = home.length === 4 && home.startsWith("K") ? home.slice(1) : home;
        const destIata = destinationIcao.length === 4 && destinationIcao.startsWith("K")
          ? destinationIcao.slice(1) : destinationIcao;

        const res = await fetch("/api/crew/flight-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origin_iata: homeIata,
            destination_iata: destIata,
            date: swapDate,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setSearchError(body.error ?? `Search failed (HTTP ${res.status})`);
          continue;
        }

        const result = await res.json();
        if (result.options?.length > 0) {
          const newOpts = (result.options as TransportOption[]).map((o) => ({
            ...o,
            _isLive: true,
          }));
          setLiveResults((prev) => {
            // Dedupe by flight number
            const existing = new Set(prev.map((o) => o.flight_number));
            const fresh = newOpts.filter((o) => !existing.has(o.flight_number));
            return [...prev, ...fresh];
          });
        }
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  // Merge cached + live results
  const allOptions = (() => {
    if (!data) return liveResults;
    const cachedFlightNums = new Set(data.options.filter((o) => o.flight_number).map((o) => o.flight_number));
    const newLive = liveResults.filter((o) => !o.flight_number || !cachedFlightNums.has(o.flight_number));
    return [...data.options, ...newLive];
  })();

  // Group: commercial flights, then ground
  const flights = allOptions.filter((o) => o.type === "commercial");
  const ground = allOptions.filter((o) => o.type !== "commercial");

  function handleSelect(opt: TransportOption) {
    onSelect({
      type: opt.type,
      flight_number: opt.flight_number,
      departure_time: opt.depart_at,
      arrival_time: opt.arrive_at,
      travel_from: opt.origin_iata,
      travel_to: opt.destination_iata,
      cost_estimate: opt.cost_estimate,
      duration_minutes: opt.duration_minutes,
      available_time: opt.fbo_arrive_at,
      duty_on_time: opt.duty_on_at,
      backup_flight: opt.backup_flight,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b bg-gray-50 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-gray-900">{crewName}</h2>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                crewRole === "PIC" ? "bg-blue-100 text-blue-700" : "bg-indigo-100 text-indigo-700"
              }`}>
                {crewRole}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                direction === "oncoming" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
              }`}>
                {direction}
              </span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              {homeAirports.join(" / ")} &rarr; {data?.destination?.iata ?? destinationIcao}
              <span className="ml-2 text-gray-400">({tailNumber})</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-8 text-center text-sm text-gray-400">Loading transport options...</div>
          )}

          {error && (
            <div className="p-4 bg-red-50 text-sm text-red-700">{error}</div>
          )}

          {!loading && !error && allOptions.length === 0 && (
            <div className="p-8 text-center text-sm text-gray-400">No transport options found for this route.</div>
          )}

          {!loading && flights.length > 0 && (
            <div>
              <div className="px-4 py-2 bg-blue-50/50 text-[10px] font-bold uppercase text-blue-600 tracking-wider">
                Commercial Flights ({flights.length})
              </div>
              {flights.map((opt, i) => (
                <OptionRow key={`f-${i}`} opt={opt} onSelect={handleSelect} direction={direction} />
              ))}
            </div>
          )}

          {!loading && ground.length > 0 && (
            <div>
              <div className="px-4 py-2 bg-gray-50 text-[10px] font-bold uppercase text-gray-500 tracking-wider">
                Ground Transport ({ground.length})
              </div>
              {ground.map((opt, i) => (
                <OptionRow key={`g-${i}`} opt={opt} onSelect={handleSelect} direction={direction} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={searchMoreFlights}
              disabled={searching}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                searching
                  ? "bg-gray-100 text-gray-400 border-gray-200"
                  : "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
              }`}
            >
              {searching ? "Searching..." : "Search More Flights"}
            </button>
            {searchError && <span className="text-[10px] text-red-500">{searchError}</span>}
            {liveResults.length > 0 && (
              <span className="text-[10px] text-green-600">{liveResults.length} live result(s)</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium rounded-lg border bg-white text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Option Row ─────────────────────────────────────────────────────────────

function OptionRow({
  opt,
  onSelect,
  direction,
}: {
  opt: TransportOption;
  onSelect: (opt: TransportOption) => void;
  direction: "oncoming" | "offgoing";
}) {
  const f = opt.feasibility;
  const allOk = f.duty_ok && f.fbo_buffer_ok && f.midnight_ok;

  return (
    <button
      onClick={() => onSelect(opt)}
      className={`w-full px-4 py-2.5 border-b hover:bg-blue-50/30 transition-colors text-left flex items-center gap-3 ${
        !allOk ? "bg-red-50/20" : ""
      }`}
    >
      {/* Type badge */}
      <span className={`text-[10px] font-bold px-2 py-1 rounded shrink-0 w-16 text-center ${typeColor(opt.type)}`}>
        {typeLabel(opt.type)}
      </span>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {opt.flight_number && (
            <span className="font-mono text-sm font-medium text-gray-900">{opt.flight_number}</span>
          )}
          {opt.depart_at && opt.arrive_at && (
            <span className="text-xs text-gray-500">
              {fmtTime(opt.depart_at)} &rarr; {fmtTime(opt.arrive_at)}
            </span>
          )}
          {opt.origin_iata && opt.destination_iata && (
            <span className="text-[10px] text-gray-400">
              {opt.origin_iata}&rarr;{opt.destination_iata}
            </span>
          )}
          {opt._isLive && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 font-bold">LIVE</span>
          )}
          {opt.has_backup && opt.backup_flight && (
            <span className="text-[9px] text-blue-400">backup: {opt.backup_flight}</span>
          )}
          {opt.connection_count > 0 && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 text-amber-600">
              {opt.connection_count} stop{opt.connection_count > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {opt.duration_minutes != null && (
          <span className="text-[10px] text-gray-400">{fmtDuration(opt.duration_minutes)}</span>
        )}
      </div>

      {/* Cost */}
      <span className="text-sm font-medium text-gray-700 shrink-0 w-16 text-right">
        ${opt.cost_estimate}
      </span>

      {/* Feasibility badges */}
      <div className="flex items-center gap-1 shrink-0">
        {direction === "oncoming" && f.duty_hours != null && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
            f.duty_ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
          }`}>
            {f.duty_hours}h duty
          </span>
        )}
        {direction === "oncoming" && f.fbo_buffer_min != null && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
            f.fbo_buffer_min >= 90 ? "bg-green-100 text-green-700"
            : f.fbo_buffer_ok ? "bg-amber-100 text-amber-700"
            : "bg-red-100 text-red-700"
          }`}>
            {f.fbo_buffer_min}m buf
          </span>
        )}
        {direction === "offgoing" && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
            f.midnight_ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
          }`}>
            {f.midnight_ok ? "home OK" : "past midnight"}
          </span>
        )}
      </div>

      {/* Score */}
      <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${
        opt.score >= 70 ? "bg-green-100 text-green-700"
        : opt.score >= 50 ? "bg-yellow-100 text-yellow-700"
        : "bg-gray-100 text-gray-500"
      }`}>
        {opt.score}
      </span>
    </button>
  );
}
