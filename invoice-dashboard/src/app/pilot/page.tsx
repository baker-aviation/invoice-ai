import Link from "next/link";

const CARDS = [
  {
    href: "/pilot/chat",
    title: "Aircraft Chat",
    description: "AI-powered advice for aircraft systems, procedures, and checklists.",
    icon: "💬",
  },
  {
    href: "/pilot/documents",
    title: "Documents",
    description: "Pilot bulletins, SOPs, and reference materials.",
    icon: "📄",
  },
  {
    href: "/pilot/tanker",
    title: "Tanker Planner",
    description: "Plan fuel tanker requests for upcoming flights.",
    icon: "⛽",
  },
];

export default function PilotHome() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Pilot Portal</h1>
      <p className="text-gray-500 mb-8">Welcome to the Baker Aviation pilot resources hub.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="block bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md hover:border-blue-300 transition-all"
          >
            <div className="text-3xl mb-3">{card.icon}</div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">{card.title}</h2>
            <p className="text-sm text-gray-500">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
