"use client";

import { useState, useCallback } from "react";

type AircraftType = "citation" | "challenger";

interface FuelData {
  fuelToDestLbs: number;
  fuelToDestGal: number;
  totalFuelLbs: number;
  totalFuelGal: number;
  flightFuelLbs: number;
  taxiFuelLbs: number;
  reserveFuelLbs: number;
  ppg: number;
}

interface FboOption {
  vendor: string;
  fbo: string | null;
  price: number;
  volume_tier: string;
  product: string;
  week_start: string;
  estimatedCost: number;
}

interface CheckResult {
  aircraft: {
    registration: string;
    type: AircraftType;
    mach: string;
    altitude: string;
    cruiseProfile: string;
  };
  route: { departure: string; destination: string };
  fuel: FuelData;
  times: { flightMinutes: number; totalMinutes: number; etaLocal: string | null };
  distances: { routeNm: number; greatCircleNm: number };
  weather: { windComponent: number; windDirection: number; windVelocity: number; isaDeviation: number };
  fboOptions: FboOption[];
  warnings: string[];
  errors: string[];
}

function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtMin(min: number | null | undefined): string {
  if (min == null || min === 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDollars(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

const AIRCRAFT_CONFIG: Record<AircraftType, { label: string; tail: string; mach: string }> = {
  citation: { label: "Citation X (N106PC)", tail: "N106PC", mach: "M.85" },
  challenger: { label: "Challenger 300 (N520FX)", tail: "N520FX", mach: "M.78" },
};

export default function ForeFlightClient() {
  const [departure, setDeparture] = useState("");
  const [destination, setDestination] = useState("");
  const [aircraftType, setAircraftType] = useState<AircraftType>("citation");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  const config = AIRCRAFT_CONFIG[aircraftType];

  const handleCheck = useCallback(async () => {
    if (!departure || !destination) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/fbo-fuel-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departure: departure.toUpperCase(),
          destination: destination.toUpperCase(),
          aircraftType,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [departure, destination, aircraftType]);

  const fuel = result?.fuel;
  const bestFbo = result?.fboOptions?.[0];

  return (
    <div className="px-6 py-6 space-y-6 max-w-4xl mx-auto">
      {/* Input Form */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">FBO Fuel Check</h2>
        <p className="text-sm text-gray-500 mb-5">
          Calculate fuel burn and find the cheapest FBO fuel option at your destination.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Departure</label>
            <input
              type="text"
              value={departure}
              onChange={(e) => setDeparture(e.target.value.toUpperCase())}
              placeholder="KBNA"
              className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm font-mono uppercase focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              onKeyDown={(e) => e.key === "Enter" && handleCheck()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Destination</label>
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value.toUpperCase())}
              placeholder="KTEB"
              className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm font-mono uppercase focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              onKeyDown={(e) => e.key === "Enter" && handleCheck()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Aircraft</label>
            <div className="flex rounded-md overflow-hidden border border-gray-300">
              <button
                onClick={() => setAircraftType("citation")}
                className={`flex-1 px-3 py-2.5 text-sm font-medium transition-colors ${
                  aircraftType === "citation"
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                Citation
              </button>
              <button
                onClick={() => setAircraftType("challenger")}
                className={`flex-1 px-3 py-2.5 text-sm font-medium transition-colors border-l border-gray-300 ${
                  aircraftType === "challenger"
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                Challenger
              </button>
            </div>
          </div>
        </div>

        {/* Aircraft Info */}
        <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
          <span>{config.tail}</span>
          <span>FL470</span>
          <span>{config.mach}</span>
        </div>

        <div className="mt-4">
          <button
            onClick={handleCheck}
            disabled={loading || !departure || !destination}
            className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {loading ? "Calculating..." : "Check Fuel & FBOs"}
          </button>
          {error && <span className="ml-3 text-sm text-red-600">{error}</span>}
        </div>
      </div>

      {/* Results */}
      {result && fuel && (
        <div className="space-y-4">
          {/* Flight Summary Bar */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <span className="text-lg font-bold text-blue-900">
                  {result.route.departure} → {result.route.destination}
                </span>
                <span className="text-sm text-blue-600">{result.aircraft.registration}</span>
              </div>
              <div className="flex items-center gap-4 text-sm text-blue-700">
                <span>{result.aircraft.cruiseProfile}</span>
                <span>{result.aircraft.altitude}</span>
                <span>{fmtMin(result.times.flightMinutes)} flight</span>
                <span>{fmtNum(result.distances.routeNm)} NM</span>
              </div>
            </div>
          </div>

          {/* Fuel Summary */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="text-md font-semibold text-gray-900 mb-4">Fuel Required</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{fmtNum(fuel.fuelToDestLbs)}</div>
                <div className="text-xs text-gray-500 mt-1">lbs to destination</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{fmtNum(fuel.fuelToDestGal)}</div>
                <div className="text-xs text-gray-500 mt-1">gallons to destination</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{fmtNum(fuel.totalFuelLbs)}</div>
                <div className="text-xs text-gray-500 mt-1">lbs total fuel</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{fmtNum(fuel.totalFuelGal)}</div>
                <div className="text-xs text-gray-500 mt-1">gallons total fuel</div>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-gray-100 flex items-center gap-6 text-sm text-gray-500">
              <span>Flight: {fmtNum(fuel.flightFuelLbs)} lbs</span>
              <span>Taxi: {fmtNum(fuel.taxiFuelLbs)} lbs</span>
              <span>Reserve: {fmtNum(fuel.reserveFuelLbs)} lbs</span>
              <span className="text-gray-400">({fuel.ppg.toFixed(2)} lbs/gal)</span>
            </div>
          </div>

          {/* FBO Options */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="text-md font-semibold text-gray-900 mb-1">FBO Fuel Options at {result.route.destination}</h3>
            <p className="text-xs text-gray-400 mb-4">
              Based on {fmtNum(fuel.fuelToDestGal)} gal fuel to destination. Prices from advertised rates.
            </p>

            {result.fboOptions.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <p className="text-sm">No advertised fuel prices found for {result.route.destination}</p>
                <p className="text-xs mt-1">Upload vendor fuel sheets on the Fuel Prices page to see options here.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="pb-2 pr-4">#</th>
                      <th className="pb-2 pr-4">Vendor</th>
                      <th className="pb-2 pr-4">FBO</th>
                      <th className="pb-2 pr-4 text-right">Price/gal</th>
                      <th className="pb-2 pr-4">Volume Tier</th>
                      <th className="pb-2 text-right">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.fboOptions.map((fbo, i) => (
                      <tr
                        key={`${fbo.vendor}-${fbo.price}-${i}`}
                        className={`border-b border-gray-50 ${i === 0 ? "bg-green-50" : ""}`}
                      >
                        <td className="py-2.5 pr-4 text-gray-400">{i + 1}</td>
                        <td className="py-2.5 pr-4 font-medium text-gray-900">{fbo.vendor}</td>
                        <td className="py-2.5 pr-4 text-gray-600">{fbo.fbo ?? "—"}</td>
                        <td className="py-2.5 pr-4 text-right font-mono">
                          {fmtDollars(fbo.price)}
                        </td>
                        <td className="py-2.5 pr-4 text-gray-500 text-xs">{fbo.volume_tier}</td>
                        <td className="py-2.5 text-right font-mono font-semibold">
                          {i === 0 ? (
                            <span className="text-green-700">{fmtDollars(fbo.estimatedCost)}</span>
                          ) : (
                            <span>
                              {fmtDollars(fbo.estimatedCost)}
                              <span className="text-xs text-red-500 ml-1">
                                +{fmtDollars(fbo.estimatedCost - (bestFbo?.estimatedCost ?? 0))}
                              </span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.fboOptions[0] && (
                  <div className="mt-3 text-xs text-gray-400">
                    Prices as of week {result.fboOptions[0].week_start}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Weather */}
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-6 text-sm text-gray-600">
              <span className="text-xs font-medium text-gray-400 uppercase">Wind</span>
              <span>
                {fmtNum(result.weather.windDirection)}&deg; / {fmtNum(result.weather.windVelocity)} kt
                <span className="text-gray-400 ml-1">
                  ({result.weather.windComponent > 0 ? "+" : ""}{fmtNum(result.weather.windComponent)} kt component)
                </span>
              </span>
              <span className="text-xs font-medium text-gray-400 uppercase ml-4">ISA</span>
              <span>
                {result.weather.isaDeviation > 0 ? "+" : ""}{fmtNum(result.weather.isaDeviation)}&deg;C
              </span>
            </div>
          </div>

          {/* Warnings */}
          {(result.warnings.length > 0 || result.errors.length > 0) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              {result.errors.map((e, i) => (
                <p key={`e${i}`} className="text-sm text-red-700 font-medium">{e}</p>
              ))}
              {result.warnings.map((w, i) => (
                <p key={`w${i}`} className="text-sm text-amber-700">{w}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
