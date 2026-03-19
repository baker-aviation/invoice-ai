import { Topbar } from "@/components/Topbar";
import JobsNav from "@/app/jobs/JobsNav";
import { createServiceClient } from "@/lib/supabase/service";
import OfferTemplateEditor from "./OfferTemplateEditor";
import CalendlyUrlEditor from "./CalendlyUrlEditor";

export default async function AdminPage() {
  const supa = createServiceClient();
  const [{ data: templates }, { data: settings }] = await Promise.all([
    supa.from("offer_templates").select("*").order("role"),
    supa.from("hiring_settings").select("key, value"),
  ]);

  const calendlyUrl =
    settings?.find((s: any) => s.key === "interview_calendly_url")?.value ?? "";

  return (
    <>
      <Topbar title="Jobs — Admin" />
      <JobsNav />
      <div className="p-6 space-y-6">
        <CalendlyUrlEditor initialUrl={calendlyUrl} />
        <OfferTemplateEditor initialTemplates={templates ?? []} />
      </div>
    </>
  );
}
