import { PilotShell } from "@/components/PilotShell";

export const metadata = { title: "Baker Aviation — Pilot Portal" };

export default function PilotLayout({ children }: { children: React.ReactNode }) {
  return <PilotShell>{children}</PilotShell>;
}
