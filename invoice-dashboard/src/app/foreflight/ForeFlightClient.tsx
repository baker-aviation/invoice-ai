"use client";

import { useState, useEffect, useCallback } from "react";

type Aircraft = { aircraftRegistration: string; aircraftModelCode: string; cruiseProfiles?: { uuid: string; profileName: string }[]; [key: string]: unknown };

type FuelPerf = {
  unit: string;
  flightFuel: number;
  taxiFuel: number;
  fuelToDestination: number;
  landingFuel: number;
  alternateFuel: number;
  reserveFuel: number;
  extraFuel: number;
  contingencyFuel: number;
  additionalFuel: number;
  totalFuel: number;
  maxTotalFuel: number;
  discretionaryFuel: number;
  co2Emission: number;
};

type TimesPerf = {
  taxiTimeMinutes: number;
  timeToDestinationMinutes: number;
  alternateTimeMinutes: number;
  reserveTimeMinutes: number;
  totalTimeMinutes: number;
  estimatedArrivalTime: string;
  estimatedArrivalTimeLocal: string;
  departureTimeZone: string;
  arrivalTimeZone: string;
};

type WeightsPerf = {
  unit: string;
  rampWeight: number;
  maxRampWeight: number;
  takeOffWeight: number;
  maxTakeOffWeight: number;
  zeroFuelWeight: number;
  maxZeroFuelWeight: number;
  landingWeight: number;
  maxLandingWeight: number;
};

type WeatherPerf = {
  averageWindComponent: number;
  averageWindDirection: number;
  averageWindVelocity: number;
  averageISADeviation: number;
};

type DistancesPerf = {
  destination: number;
  gcdDestination: number;
  alternate: number;
  gcdAlternate: number;
};

type Performance = {
  fuel: FuelPerf;
  times: TimesPerf;
  weights: WeightsPerf;
  weather: WeatherPerf;
  distances: DistancesPerf;
  errors: string[];
  warnings: string[];
};

function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtMin(min: number | null | undefined): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function ForeFlightClient() {
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form
  const [departure, setDeparture] = useState("");
  const [destination, setDestination] = useState("");
  const [selectedAircraft, setSelectedAircraft] = useState("");
  const [cruiseProfileUUID, setCruiseProfileUUID] = useState("");
  const [alternate, setAlternate] = useState("");
  const [route, setRoute] = useState("");
  const [altitude, setAltitude] = useState("");
  const [people, setPeople] = useState("4");
  const [cargo, setCargo] = useState("");

  // Results
  const [result, setResult] = useState<{ performance: Performance; _request: unknown; [key: string]: unknown } | null>(null);
  const [rawJson, setRawJson] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // Load aircraft list
  const [aircraftError, setAircraftError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/foreflight?action=aircraft")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setAircraftError(data.error);
          return;
        }
        const list = Array.isArray(data) ? data : data.aircraft ?? [];
        setAircraft(list);
        if (list.length > 0 && !selectedAircraft) {
          setSelectedAircraft(list[0].aircraftRegistration);
        }
      })
      .catch((err) => setAircraftError(String(err)));
  }, []);

  // Get cruise profiles for selected aircraft
  const selectedAc = aircraft.find((a) => a.aircraftRegistration === selectedAircraft);
  const cruiseProfiles = selectedAc?.cruiseProfiles ?? [];

  // Auto-select first cruise profile when aircraft changes (prefer "Long Range" if available)
  useEffect(() => {
    if (cruiseProfiles.length === 0) { setCruiseProfileUUID(""); return; }
    const lrc = cruiseProfiles.find((p) => /long.range/i.test(p.profileName));
    setCruiseProfileUUID(lrc?.uuid ?? cruiseProfiles[0].uuid);
  }, [selectedAircraft]);

  const handleSubmit = useCallback(async () => {
    if (!departure || !destination || !selectedAircraft) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setRawJson(null);

    try {
      const res = await fetch("/api/foreflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departure: departure.toUpperCase(),
          destination: destination.toUpperCase(),
          aircraftRegistration: selectedAircraft,
          cruiseProfileUUID: cruiseProfileUUID || undefined,
          alternate: alternate || undefined,
          route: route || undefined,
          altitude: altitude || undefined,
          people: people || undefined,
          cargo: cargo || undefined,
        }),
      });

      const data = await res.json();
      const json = JSON.stringify(data, null, 2);
      setRawJson(json);

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
  }, [departure, destination, selectedAircraft, cruiseProfileUUID, alternate, route, altitude, people, cargo]);

  const perf = result?.performance;
  const fuel = perf?.fuel;
  const times = perf?.times;
  const weights = perf?.weights;
  const weather = perf?.weather;
  const distances = perf?.distances;
  const flightData = result?.flightData as Record<string, unknown> | undefined;
  const ffRoute = (flightData?.routeToDestination as Record<string, unknown> | undefined)?.route as string | undefined;
  const ffAltitude = (flightData?.routeToDestination as Record<string, unknown> | undefined)?.altitude as Record<string, unknown> | undefined;
  const ffCruiseProfile = (perf as unknown as Record<string, unknown>)?.destinationRouteInformation
    ? ((perf as unknown as Record<string, unknown>).destinationRouteInformation as Record<string, unknown>)?.cruiseProfile as string | undefined
    : undefined;

  return (
    <div className="px-6 py-6 space-y-6">
      {aircraftError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>ForeFlight API:</strong> {aircraftError}
        </div>
      )}
      {/* Input Form */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Fuel Burn Calculator</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Departure</label>
            <input
              type="text"
              value={departure}
              onChange={(e) => setDeparture(e.target.value)}
              placeholder="KBNA"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Destination</label>
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="KTEB"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Aircraft</label>
            <select
              value={selectedAircraft}
              onChange={(e) => setSelectedAircraft(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {aircraft.length === 0 && <option value="">Loading...</option>}
              {aircraft.map((a) => (
                <option key={a.aircraftRegistration} value={a.aircraftRegistration}>
                  {a.aircraftRegistration} ({a.aircraftModelCode})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Cruise Profile</label>
            <select
              value={cruiseProfileUUID}
              onChange={(e) => setCruiseProfileUUID(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {cruiseProfiles.length === 0 && <option value="">—</option>}
              {cruiseProfiles.map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {p.profileName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Alternate</label>
            <input
              type="text"
              value={alternate}
              onChange={(e) => setAlternate(e.target.value)}
              placeholder="KEWR"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Route</label>
            <input
              type="text"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              placeholder="DCT J6 SBJ"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Altitude (FL)</label>
            <input
              type="text"
              value={altitude}
              onChange={(e) => setAltitude(e.target.value)}
              placeholder="430"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Passengers</label>
            <input
              type="text"
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              placeholder="4"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Cargo (lbs)</label>
            <input
              type="text"
              value={cargo}
              onChange={(e) => setCargo(e.target.value)}
              placeholder="200"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleSubmit}
            disabled={loading || !departure || !destination || !selectedAircraft}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {loading ? "Calculating..." : "Calculate Fuel"}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>

      {/* Results */}
      {perf && (
        <div className="space-y-4">
          {/* Route + Cruise Profile */}
          {(ffRoute || ffCruiseProfile) && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-blue-600 uppercase tracking-wide">ForeFlight Route</span>
                <div className="flex items-center gap-3">
                  {ffCruiseProfile && <span className="text-xs font-medium text-blue-500">{ffCruiseProfile}</span>}
                  {ffAltitude && <span className="text-xs font-mono text-blue-500">FL{String(ffAltitude.altitude ?? "")}</span>}
                </div>
              </div>
              {ffRoute && <p className="mt-1 font-mono text-sm text-blue-900">{ffRoute}</p>}
            </div>
          )}
          {/* Fuel Breakdown */}
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="text-md font-semibold text-gray-900 mb-3">Fuel Breakdown ({fuel?.unit})</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-6 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Flight Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.flightFuel)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Taxi Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.taxiFuel)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Fuel to Dest</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.fuelToDestination)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Landing Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.landingFuel)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Alternate Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.alternateFuel)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Reserve Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.reserveFuel)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Contingency</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.contingencyFuel)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Extra/Additional</span>
                <span className="font-mono font-medium">{fmtNum((fuel?.extraFuel ?? 0) + (fuel?.additionalFuel ?? 0))}</span>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 col-span-2 md:col-span-4">
                <span className="text-gray-900 font-semibold">Total Fuel Required</span>
                <span className="font-mono font-bold text-lg">{fmtNum(fuel?.totalFuel)}</span>
              </div>
              <div className="flex justify-between col-span-2 md:col-span-4">
                <span className="text-gray-500">Max Total Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.maxTotalFuel)}</span>
              </div>
              <div className="flex justify-between col-span-2 md:col-span-4">
                <span className="text-gray-500">Discretionary Fuel</span>
                <span className="font-mono font-medium">{fmtNum(fuel?.discretionaryFuel)}</span>
              </div>
              {fuel?.co2Emission != null && (
                <div className="flex justify-between col-span-2 md:col-span-4">
                  <span className="text-gray-500">CO2 Emission</span>
                  <span className="font-mono font-medium">{fmtNum(fuel.co2Emission)} kg</span>
                </div>
              )}
            </div>
          </div>

          {/* Times + Distance + Weather */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Times */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h3 className="text-md font-semibold text-gray-900 mb-3">Times</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Flight Time</span>
                  <span className="font-mono font-medium">{fmtMin(times?.timeToDestinationMinutes)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Taxi</span>
                  <span className="font-mono font-medium">{fmtMin(times?.taxiTimeMinutes)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">To Alternate</span>
                  <span className="font-mono font-medium">{fmtMin(times?.alternateTimeMinutes)}</span>
                </div>
                <div className="flex justify-between border-t border-gray-200 pt-2">
                  <span className="text-gray-900 font-semibold">Total</span>
                  <span className="font-mono font-bold">{fmtMin(times?.totalTimeMinutes)}</span>
                </div>
                {times?.estimatedArrivalTimeLocal && (
                  <div className="flex justify-between pt-1">
                    <span className="text-gray-500">ETA (local)</span>
                    <span className="font-mono text-xs">{new Date(times.estimatedArrivalTimeLocal).toLocaleTimeString()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Distances */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h3 className="text-md font-semibold text-gray-900 mb-3">Distances (NM)</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Route Distance</span>
                  <span className="font-mono font-medium">{fmtNum(distances?.destination)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Great Circle</span>
                  <span className="font-mono font-medium">{fmtNum(distances?.gcdDestination)}</span>
                </div>
                {distances?.alternate != null && distances.alternate > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">To Alternate</span>
                    <span className="font-mono font-medium">{fmtNum(distances.alternate)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Weather + Weights */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h3 className="text-md font-semibold text-gray-900 mb-3">Weather & Weights</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Wind Component</span>
                  <span className="font-mono font-medium">{fmtNum(weather?.averageWindComponent)} kt</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg Wind</span>
                  <span className="font-mono font-medium">{fmtNum(weather?.averageWindDirection)}&deg; / {fmtNum(weather?.averageWindVelocity)} kt</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">ISA Dev</span>
                  <span className="font-mono font-medium">{weather?.averageISADeviation != null ? `${weather.averageISADeviation > 0 ? "+" : ""}${fmtNum(weather.averageISADeviation)}&deg;C` : "—"}</span>
                </div>
                <div className="border-t border-gray-200 pt-2 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Ramp Wt</span>
                    <span className="font-mono font-medium">{fmtNum(weights?.rampWeight)} / {fmtNum(weights?.maxRampWeight)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Takeoff Wt</span>
                    <span className="font-mono font-medium">{fmtNum(weights?.takeOffWeight)} / {fmtNum(weights?.maxTakeOffWeight)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Landing Wt</span>
                    <span className="font-mono font-medium">{fmtNum(weights?.landingWeight)} / {fmtNum(weights?.maxLandingWeight)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Warnings / Errors */}
          {(perf.warnings?.length > 0 || perf.errors?.length > 0) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              {perf.errors?.map((e, i) => (
                <p key={`e${i}`} className="text-sm text-red-700 font-medium">{e}</p>
              ))}
              {perf.warnings?.map((w, i) => (
                <p key={`w${i}`} className="text-sm text-amber-700">{w}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Raw JSON toggle */}
      {rawJson && (
        <div>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-xs text-gray-400 hover:text-gray-600 font-mono"
          >
            {showRaw ? "Hide" : "Show"} raw JSON response
          </button>
          {showRaw && (
            <pre className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-xs font-mono text-gray-700 overflow-x-auto max-h-[600px] overflow-y-auto">
              {rawJson}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
