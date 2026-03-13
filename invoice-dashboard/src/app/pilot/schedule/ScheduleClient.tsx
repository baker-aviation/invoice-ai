"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Rotation = {
  id: number;
  crew_member_id: number;
  tail_number: string;
  rotation_start: string;
  rotation_end: string | null;
};

type TimeOff = {
  id: number;
  request_type: string;
  start_date: string;
  end_date: string;
  status: string;
  reason: string | null;
};

export default function ScheduleClient() {
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Get pilot profile to find crew_member_id
    const profileRes = await fetch("/api/pilot/time-off");
    const profileData = await profileRes.json();
    if (profileData.ok) {
      setTimeOff(
        (profileData.requests ?? []).filter(
          (r: TimeOff) => r.status === "approved",
        ),
      );
    }

    // Rotations require crew_member link — fetch via a lightweight endpoint
    // For now we surface time-off; rotations will show once linked
    setRotations([]);
  }, []);

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  if (loading) {
    return <div className="text-gray-400">Loading schedule...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">My Schedule</h1>

      {/* Current Rotations */}
      <div className="bg-white rounded-xl border shadow-sm p-5">
        <h2 className="text-base font-semibold mb-3">Current Rotations</h2>
        {rotations.length === 0 ? (
          <p className="text-sm text-gray-400">No active rotations.</p>
        ) : (
          <div className="space-y-2">
            {rotations.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <span className="text-sm font-medium">{r.tail_number}</span>
                <span className="text-sm text-gray-500">
                  {r.rotation_start} — {r.rotation_end ?? "Ongoing"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Approved Time Off */}
      <div className="bg-white rounded-xl border shadow-sm p-5">
        <h2 className="text-base font-semibold mb-3">Approved Time Off</h2>
        {timeOff.length === 0 ? (
          <p className="text-sm text-gray-400">No approved time off.</p>
        ) : (
          <div className="space-y-2">
            {timeOff.map((t) => (
              <div key={t.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div>
                  <span className="text-sm font-medium">
                    {t.request_type === "time_off" ? "Time Off" : "Standby"}
                  </span>
                  {t.reason && (
                    <span className="text-sm text-gray-400 ml-2">— {t.reason}</span>
                  )}
                </div>
                <span className="text-sm text-gray-500">{t.start_date} — {t.end_date}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
