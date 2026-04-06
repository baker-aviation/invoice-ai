export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import JobsNav from "@/app/jobs/JobsNav";
import { createServiceClient } from "@/lib/supabase/service";
import GroundCalendlyEditor from "./GroundCalendlyEditor";
import GroundEmailTemplateEditor from "./GroundEmailTemplateEditor";
import GroundRejectionEmailEditor from "./GroundRejectionEmailEditor";

export default async function GroundAdminPage() {
  const supa = createServiceClient();
  const { data: settings } = await supa
    .from("hiring_settings")
    .select("key, value")
    .like("key", "ground_%");

  const s = (key: string) =>
    settings?.find((r: any) => r.key === key)?.value ?? "";

  const rejectionTemplates: Record<string, string> = {};
  for (const row of settings ?? []) {
    if ((row as any).key?.startsWith("ground_rejection_email_")) {
      rejectionTemplates[(row as any).key] = (row as any).value ?? "";
    }
  }

  return (
    <>
      <Topbar title="Jobs — Ground Admin" />
      <JobsNav />
      <div className="p-6 space-y-6">
        <div className="rounded-xl border border-teal-200 bg-teal-50/30 p-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-teal-500" />
            <h2 className="text-sm font-semibold text-teal-800">Ground Pipeline Settings</h2>
          </div>
          <p className="text-xs text-teal-600">
            Configure email templates, scheduling links, and rejection templates for ground job candidates
            (A&P mechanics, sales, fleet managers, line service, etc.)
          </p>
        </div>

        <GroundCalendlyEditor
          label="Phone Screen — Scheduling Link"
          description="Included in the phone screen scheduling email sent to ground candidates."
          settingsKey="ground_phone_screen_calendly_url"
          initialUrl={s("ground_phone_screen_calendly_url")}
        />

        <GroundCalendlyEditor
          label="Interview — Scheduling Link"
          description="Included in the interview scheduling email sent to ground candidates."
          settingsKey="ground_interview_calendly_url"
          initialUrl={s("ground_interview_calendly_url")}
        />

        <GroundEmailTemplateEditor
          label="Phone Screen Email Template"
          description='Sent when a ground candidate is moved to "Phone Screen". Use {{name}} for first name, {{calendly_link}} for the scheduling URL.'
          settingsKey="ground_phone_screen_email_template"
          initialTemplate={s("ground_phone_screen_email_template")}
        />

        <GroundEmailTemplateEditor
          label="Interview Email Template"
          description='Sent when a ground candidate is moved to "Interview". Use {{name}} for first name, {{calendly_link}} for the scheduling URL.'
          settingsKey="ground_interview_email_template"
          initialTemplate={s("ground_interview_email_template")}
        />

        <GroundRejectionEmailEditor initialTemplates={rejectionTemplates} />
      </div>
    </>
  );
}
