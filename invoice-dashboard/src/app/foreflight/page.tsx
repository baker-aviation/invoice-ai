import { Topbar } from "@/components/Topbar";

export default function ForeFlightPage() {
  return (
    <>
      <Topbar title="ForeFlight" />
      <div className="px-6 py-6">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-gray-900">ForeFlight Dispatch</h2>
          <p className="mt-2 text-sm text-gray-500">
            Flight planning, fuel burn calculations, and dispatch tools — coming soon.
          </p>
        </div>
      </div>
    </>
  );
}
