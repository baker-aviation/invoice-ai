export default function FormLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-slate-900 text-white py-4 px-4 sm:px-6">
        <div className="max-w-2xl mx-auto font-bold tracking-tight">Baker Aviation</div>
      </header>
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</main>
    </div>
  );
}
