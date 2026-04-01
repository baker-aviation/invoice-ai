export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import JetInsightClient from "../JetInsightClient";

export default async function JetInsightPage({
  params,
}: {
  params: Promise<{ tab?: string[] }>;
}) {
  const { tab: tabSegments } = await params;
  const initialTab = tabSegments?.[0] ?? null;

  return (
    <>
      <Topbar title="JetInsight Sync" />
      <JetInsightClient initialTab={initialTab} />
    </>
  );
}
