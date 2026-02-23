export function Topbar({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
      <div className="px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{title}</h1>
        <div className="text-xs text-gray-500">Baker Aviation • Internal</div>
      </div>
    </header>
  );
}