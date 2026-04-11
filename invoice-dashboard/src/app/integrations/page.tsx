"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type IntegrationCard = {
  key: string;
  name: string;
  description: string;
  href: string;
  statusEndpoint?: string;
};

const INTEGRATIONS: IntegrationCard[] = [
  {
    key: "hamilton",
    name: "Hamilton",
    description: "Declined trip feed — broker-declined trips surfaced for follow-up.",
    href: "/integrations/hamilton",
    statusEndpoint: "/api/hamilton/config",
  },
  {
    key: "jetinsight",
    name: "JetInsight",
    description: "Schedule JSON + compliance documents sync. Primary source for trip data.",
    href: "/integrations/jetinsight",
    statusEndpoint: "/api/jetinsight/sync/status?limit=1",
  },
  {
    key: "hasdata",
    name: "HasData",
    description: "Google Flights scraper — powers crew swap flight search.",
    href: "/integrations/hasdata",
  },
];

type Health = { lastRun?: string | null; ok?: boolean; error?: string };

export default function IntegrationsIndexPage() {
  const [health, setHealth] = useState<Record<string, Health>>({});

  useEffect(() => {
    for (const intg of INTEGRATIONS) {
      if (!intg.statusEndpoint) continue;
      fetch(intg.statusEndpoint)
        .then((r) => r.json())
        .then((data) => {
          const lastRun =
            data?.runs?.[0]?.started_at ??
            data?.last_run ??
            data?.updated_at ??
            null;
          setHealth((h) => ({ ...h, [intg.key]: { lastRun, ok: true } }));
        })
        .catch((err) =>
          setHealth((h) => ({ ...h, [intg.key]: { ok: false, error: String(err) } })),
        );
    }
  }, []);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {INTEGRATIONS.map((intg) => {
        const h = health[intg.key];
        return (
          <Link
            key={intg.key}
            href={intg.href}
            className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm hover:border-slate-400 hover:shadow transition-all"
          >
            <div className="flex items-start justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{intg.name}</h3>
              {h && (
                <span
                  className={
                    "h-2 w-2 rounded-full " +
                    (h.ok ? "bg-emerald-500" : "bg-red-500")
                  }
                  title={h.ok ? "OK" : h.error ?? "Error"}
                />
              )}
            </div>
            <p className="mt-2 text-sm text-slate-600">{intg.description}</p>
            {h?.lastRun && (
              <p className="mt-3 text-xs text-slate-400">
                Last sync: {new Date(h.lastRun).toLocaleString()}
              </p>
            )}
          </Link>
        );
      })}
    </div>
  );
}
