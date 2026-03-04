import TankerPlanner from "@/app/tanker/TankerPlanner";

export default function PilotTankerPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Tanker Planner</h1>
      <p className="text-gray-500 text-sm mb-6">
        Plan fuel tanker requests for upcoming flights.
      </p>
      <TankerPlanner />
    </div>
  );
}
