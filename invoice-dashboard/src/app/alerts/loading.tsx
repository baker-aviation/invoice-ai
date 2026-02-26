export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      {/* Slack flush bar skeleton */}
      <div className="rounded-xl border bg-white shadow-sm px-4 py-3 h-14 animate-pulse bg-gray-50" />

      {/* Filter bar skeleton */}
      <div className="rounded-xl border bg-white shadow-sm p-4">
        <div className="flex gap-3">
          <div className="h-10 w-32 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-10 w-48 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-10 w-64 rounded-lg bg-gray-100 animate-pulse" />
        </div>
      </div>

      {/* Table skeleton */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="h-10 bg-gray-50 border-b" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
            <div className="h-4 w-28 rounded bg-gray-100 animate-pulse" />
            <div className="h-4 w-36 rounded bg-gray-100 animate-pulse" />
            <div className="h-4 w-32 rounded bg-gray-100 animate-pulse" />
            <div className="h-4 w-16 rounded bg-gray-100 animate-pulse" />
            <div className="h-4 w-16 rounded bg-gray-100 animate-pulse" />
            <div className="h-4 w-24 rounded bg-gray-100 animate-pulse ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
