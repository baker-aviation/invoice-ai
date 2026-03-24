"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ intervalSeconds = 120 }: { intervalSeconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const base = intervalSeconds * 1000;
    const jitter = () => base + Math.random() * (base * 0.1); // +0-10% jitter
    let id: ReturnType<typeof setTimeout>;
    const tick = () => { router.refresh(); id = setTimeout(tick, jitter()); };
    id = setTimeout(tick, jitter());
    return () => clearTimeout(id);
  }, [router, intervalSeconds]);

  return null;
}
