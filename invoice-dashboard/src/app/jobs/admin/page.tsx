import { Topbar } from "@/components/Topbar";
import JobsNav from "@/app/jobs/JobsNav";
import { createServiceClient } from "@/lib/supabase/service";
import OfferTemplateEditor from "./OfferTemplateEditor";
import CalendlyUrlEditor from "./CalendlyUrlEditor";
import RejectionEmailEditor from "./RejectionEmailEditor";

export default async function AdminPage() {
  const supa = createServiceClient();
  const [{ data: templates }, { data: settings }] = await Promise.all([
    supa.from("offer_templates").select("*").order("role"),
    supa.from("hiring_settings").select("key, value"),
  ]);

  const calendlyUrl =
    settings?.find((s: any) => s.key === "interview_calendly_url")?.value ?? "";

  const rejectionTemplates: Record<string, string> = {};
  for (const s of settings ?? []) {
    if ((s as any).key?.startsWith("rejection_email_")) {
      rejectionTemplates[(s as any).key] = (s as any).value ?? "";
    }
  }

  return (
    <>
      <Topbar title="Jobs — Admin" />
      <JobsNav />
      <div className="p-6 space-y-6">
        <CalendlyUrlEditor initialUrl={calendlyUrl} />
        <RejectionEmailEditor initialTemplates={rejectionTemplates} />
        <OfferTemplateEditor initialTemplates={templates ?? []} />
      </div>
    </>
  );
}
