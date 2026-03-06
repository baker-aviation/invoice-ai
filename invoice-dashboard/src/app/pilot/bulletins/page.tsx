import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect } from "next/navigation";
import BulletinsList from "./BulletinsList";

export const dynamic = "force-dynamic";

export default async function BulletinsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const role = user.app_metadata?.role ?? user.user_metadata?.role;
  if (role !== "pilot" && role !== "admin") redirect("/");

  const supa = createServiceClient();
  const { data: bulletins } = await supa
    .from("pilot_bulletins")
    .select("id, title, summary, category, published_at, video_filename, created_at, pilot_bulletin_attachments(id, filename)")
    .order("published_at", { ascending: false });

  return (
    <BulletinsList
      bulletins={bulletins ?? []}
      isAdmin={role === "admin"}
    />
  );
}
