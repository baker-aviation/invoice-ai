export const metadata = { title: "Baker Aviation \u2014 AOG Van" };

export default function VanLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-slate-800 text-white px-4 py-3 flex items-center gap-3 sticky top-0 z-50">
        <div className="text-sm font-bold">Baker Aviation</div>
        <div className="text-xs text-slate-400">AOG Van</div>
      </header>
      <main className="pb-20">{children}</main>
    </div>
  );
}
