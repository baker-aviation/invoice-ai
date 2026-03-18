import { Topbar } from "@/components/Topbar";
import JobsNav from "@/app/jobs/JobsNav";
import { createServiceClient } from "@/lib/supabase/service";
import OfferTemplateEditor from "./OfferTemplateEditor";

export default async function AdminPage() {
  const supa = createServiceClient();
  const { data: templates } = await supa
    .from("offer_templates")
    .select("*")
    .order("role");

  return (
    <>
      <Topbar title="Jobs — Admin" />
      <JobsNav />
      <div className="p-6">
        <OfferTemplateEditor initialTemplates={templates ?? []} />
      </div>
    </>
  );
}
