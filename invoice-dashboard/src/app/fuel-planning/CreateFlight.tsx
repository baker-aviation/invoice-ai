"use client";

import { useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────

interface CrewEntry { position: "PIC" | "SIC" | "CA"; crewId: string; weight: string }
interface PaxEntry { type: "Male" | "Female" | "Child" | "Infant"; weight: string }

interface CreateResult {
  flight?: {
    flightId: string;
    performance?: Record<string, unknown>;
    flightData?: Record<string, unknown>;
  };
  error?: string;
}

const TAILS = [
  "N102VR", "N106PC", "N125DZ", "N125TH", "N186DB", "N187CR", "N201HR",
  "N301HR", "N371DB", "N416F", "N513JB", "N51GB", "N519FX", "N520FX",
  "N521FX", "N526FX", "N529FX", "N533FX", "N541FX", "N552FX", "N553FX",
  "N554FX", "N555FX", "N700LH", "N703TX", "N733FL", "N818CF",
  "N860TX", "N883TR", "N910E", "N939TX", "N954JS", "N955GH",
  "N957JS", "N971JS", "N988TX", "N992MG", "N998CX",
];

// ─── Component ────────────────────────────────────────────────────────

export default function CreateFlight() {
  // Flight basics
  const [departure, setDeparture] = useState("");
  const [destination, setDestination] = useState("");
  const [tail, setTail] = useState("N520FX");
  const [depTime, setDepTime] = useState(() => {
    const d = new Date(Date.now() + 3600_000);
    return d.toISOString().slice(0, 16); // datetime-local format
  });
  const [callsign, setCallsign] = useState("");
  const [tripId, setTripId] = useState("");

  // Route
  const [route, setRoute] = useState("");
  const [altitude, setAltitude] = useState("410");
  const [alternate, setAlternate] = useState("");

  // Crew
  const [crew, setCrew] = useState<CrewEntry[]>([
    { position: "PIC", crewId: "", weight: "190" },
    { position: "SIC", crewId: "", weight: "190" },
  ]);

  // Passengers
  const [passengers, setPassengers] = useState<PaxEntry[]>([]);
  const [cargo, setCargo] = useState("");

  // Fuel
  const [fuelPolicy, setFuelPolicy] = useState("MinimumRequiredFuel");
  const [taxi, setTaxi] = useState("300");

  // Notes
  const [notes, setNotes] = useState("");
  const [item18, setItem18] = useState("");

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);

  const updateCrew = (idx: number, field: keyof CrewEntry, value: string) => {
    setCrew(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  };

  const addPax = () => setPassengers(prev => [...prev, { type: "Male", weight: "200" }]);
  const removePax = (idx: number) => setPassengers(prev => prev.filter((_, i) => i !== idx));
  const updatePax = (idx: number, field: keyof PaxEntry, value: string) => {
    setPassengers(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const handlePush = useCallback(async () => {
    if (!departure || !destination) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const flight: Record<string, unknown> = {
      departure: departure.toUpperCase(),
      destination: destination.toUpperCase(),
      aircraftRegistration: tail,
      scheduledTimeOfDeparture: new Date(depTime).toISOString(),
      flightRule: "IFR",
      atcTypeOfFlight: "G",
      windOptions: { windModel: "Forecasted" },
    };

    // Callsign
    if (callsign.trim()) flight.callsign = callsign.trim().toUpperCase();

    // Trip ID
    if (tripId.trim()) flight.tripId = tripId.trim();

    // Route
    const routeObj: Record<string, unknown> = {};
    if (route.trim()) routeObj.route = route.trim().toUpperCase();
    if (altitude) routeObj.altitude = { altitude: Number(altitude), unit: "FL" };
    if (Object.keys(routeObj).length > 0) flight.routeToDestination = routeObj;

    // Alternate
    if (alternate.trim()) flight.alternate = alternate.trim().toUpperCase();

    // Crew
    const crewArr = crew
      .filter(c => c.crewId.trim())
      .map(c => ({
        position: c.position,
        crewId: c.crewId.trim(),
        ...(c.weight ? { weight: Number(c.weight) } : {}),
      }));
    if (crewArr.length > 0) flight.crew = crewArr;

    // Load
    const totalPeople = crewArr.length + passengers.length;
    const load: Record<string, unknown> = {};
    if (totalPeople > 0) load.people = totalPeople;
    if (cargo && Number(cargo) > 0) load.cargo = Number(cargo);
    if (passengers.length > 0) {
      load.passengers = passengers.map(p => ({
        type: p.type,
        ...(p.weight ? { weight: Number(p.weight) } : {}),
      }));
    }
    if (Object.keys(load).length > 0) flight.load = load;

    // Fuel
    flight.fuel = {
      fuelPolicy,
      fuelPolicyValue: 0,
      taxi: Number(taxi) || 300,
      fuelType: "Jet-A",
      fuelUnit: "Pound",
    };

    // Notes
    if (notes.trim()) flight.dispatcherNotes = notes.trim();
    if (item18.trim()) flight.item18 = { remarks: item18.trim() };

    try {
      const res = await fetch("/api/foreflight?action=create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flight }),
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
  }, [departure, destination, tail, depTime, callsign, tripId, route, altitude, alternate, crew, passengers, cargo, fuelPolicy, taxi, notes, item18]);

  const perf = result?.flight?.performance as Record<string, unknown> | undefined;
  const fuel = perf?.fuel as Record<string, unknown> | undefined;
  const times = perf?.times as Record<string, unknown> | undefined;
  const distances = perf?.distances as Record<string, unknown> | undefined;

  return (
    <div className="px-6 py-6 space-y-4 max-w-5xl mx-auto">
      {/* Form */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Push Flight to ForeFlight</h2>
        <p className="text-sm text-gray-500 mb-5">
          Create a flight plan on ForeFlight Dispatch with crew, passengers, and routing.
        </p>

        {/* Row 1: Core fields */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Field label="Departure *" value={departure} onChange={setDeparture} placeholder="KVNY" mono upper />
          <Field label="Destination *" value={destination} onChange={setDestination} placeholder="KLAS" mono upper />
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Aircraft *</label>
            <select
              value={tail}
              onChange={e => setTail(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {TAILS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Departure Time (UTC) *</label>
            <input
              type="datetime-local"
              value={depTime}
              onChange={e => setDepTime(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        {/* Row 2: Route */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="md:col-span-2">
            <Field label="Route" value={route} onChange={setRoute} placeholder="ORTON2 DAG J146 BLD" mono upper />
          </div>
          <Field label="Altitude (FL)" value={altitude} onChange={setAltitude} placeholder="410" mono />
          <Field label="Alternate" value={alternate} onChange={setAlternate} placeholder="KPHX" mono upper />
        </div>

        {/* Row 3: Callsign, Trip ID */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Field label="Callsign" value={callsign} onChange={setCallsign} placeholder="KOW520" mono upper />
          <Field label="Trip ID" value={tripId} onChange={setTripId} placeholder="ABC123" mono />
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Fuel Policy</label>
            <select
              value={fuelPolicy}
              onChange={e => setFuelPolicy(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="MinimumRequiredFuel">Min Required</option>
              <option value="MaximumFuel">Maximum</option>
              <option value="ExtraFuel">Extra</option>
              <option value="LandingFuel">Landing</option>
            </select>
          </div>
          <Field label="Taxi Fuel (lb)" value={taxi} onChange={setTaxi} placeholder="300" mono />
        </div>

        {/* Crew */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-500 mb-2">Crew</label>
          <div className="space-y-2">
            {crew.map((c, i) => (
              <div key={i} className="grid grid-cols-4 gap-2">
                <select
                  value={c.position}
                  onChange={e => updateCrew(i, "position", e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="PIC">PIC</option>
                  <option value="SIC">SIC</option>
                  <option value="CA">CA</option>
                </select>
                <input
                  type="text"
                  value={c.crewId}
                  onChange={e => updateCrew(i, "crewId", e.target.value)}
                  placeholder="email@baker-aviation.com"
                  className="col-span-2 rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <input
                  type="text"
                  value={c.weight}
                  onChange={e => updateCrew(i, "weight", e.target.value.replace(/\D/g, ""))}
                  placeholder="Weight (lb)"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Passengers */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-gray-500">Passengers</label>
            <button
              onClick={addPax}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              + Add Passenger
            </button>
          </div>
          {passengers.length === 0 && (
            <p className="text-xs text-gray-400">No passengers added. Click &quot;+ Add Passenger&quot; above.</p>
          )}
          <div className="space-y-2">
            {passengers.map((p, i) => (
              <div key={i} className="grid grid-cols-4 gap-2">
                <select
                  value={p.type}
                  onChange={e => updatePax(i, "type", e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Child">Child</option>
                  <option value="Infant">Infant</option>
                </select>
                <input
                  type="text"
                  value={p.weight}
                  onChange={e => updatePax(i, "weight", e.target.value.replace(/\D/g, ""))}
                  placeholder="Weight (lb)"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <div /> {/* spacer */}
                <button
                  onClick={() => removePax(i)}
                  className="text-xs text-red-500 hover:text-red-700 font-medium text-right pr-2"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <Field label="Cargo (lb)" value={cargo} onChange={setCargo} placeholder="0" mono />
          </div>
        </div>

        {/* Notes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Dispatcher Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Item 18 Remarks</label>
            <textarea
              value={item18}
              onChange={e => setItem18(e.target.value)}
              placeholder="ICAO Item 18 remarks..."
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3">
          <button
            onClick={handlePush}
            disabled={loading || !departure || !destination}
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {loading ? "Pushing..." : "Push to ForeFlight"}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>

      {/* Result */}
      {result?.flight && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-green-700 font-semibold">Flight Created</span>
            <span className="text-xs font-mono text-green-600">ID: {result.flight.flightId}</span>
          </div>

          {fuel && times && distances && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-xs text-green-600">ETE</span>
                <div className="font-mono font-semibold text-green-900">{Math.floor((times.timeToDestinationMinutes as number) / 60)}h {Math.round((times.timeToDestinationMinutes as number) % 60)}m</div>
              </div>
              <div>
                <span className="text-xs text-green-600">Distance</span>
                <div className="font-mono font-semibold text-green-900">{(distances.destination as number).toLocaleString("en-US", { maximumFractionDigits: 1 })} NM</div>
              </div>
              <div>
                <span className="text-xs text-green-600">Total Fuel</span>
                <div className="font-mono font-semibold text-green-900">{(fuel.totalFuel as number).toLocaleString()} lb</div>
              </div>
              <div>
                <span className="text-xs text-green-600">Landing Fuel</span>
                <div className="font-mono font-semibold text-green-900">{(fuel.landingFuel as number).toLocaleString()} lb</div>
              </div>
            </div>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-green-600 hover:text-green-800 font-medium">Show Raw Response</summary>
            <pre className="mt-2 rounded border border-green-200 bg-white p-3 font-mono text-gray-700 overflow-x-auto max-h-[400px] overflow-y-auto">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Field helper ─────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, mono, upper }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; mono?: boolean; upper?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${mono ? "font-mono" : ""} ${upper ? "uppercase" : ""}`}
      />
    </div>
  );
}
