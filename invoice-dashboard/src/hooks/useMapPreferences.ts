"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type MapPrefs = Record<string, boolean>;

/**
 * Per-user map preferences — loads from Supabase, saves on change with debounce.
 *
 * @param pageKey - unique key per map page (e.g. "ops_map", "van_map")
 * @param defaults - default toggle values
 */
export function useMapPreferences(pageKey: string, defaults: MapPrefs) {
  const [prefs, setPrefs] = useState<MapPrefs>(defaults);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const latestPrefs = useRef(prefs);
  latestPrefs.current = prefs;

  // Load on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/user/preferences");
        if (!res.ok || cancelled) return;
        const { preferences } = await res.json();
        const page = preferences?.[pageKey];
        if (page && typeof page === "object" && !cancelled) {
          setPrefs((prev) => ({ ...prev, ...page }));
        }
      } catch {
        // Silently fall back to defaults
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [pageKey]);

  // Debounced save
  const save = useCallback((updated: MapPrefs) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await fetch("/api/user/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: { [pageKey]: updated } }),
        });
      } catch {
        // Silent fail — preferences are nice-to-have
      }
    }, 800);
  }, [pageKey]);

  const toggle = useCallback((key: string) => {
    setPrefs((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      save(updated);
      return updated;
    });
  }, [save]);

  return { prefs, toggle, loaded };
}
