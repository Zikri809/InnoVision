import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardContent } from "./dashboard-content";

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, consent_given_at")
    .eq("id", user.id)
    .single();

  return (
    <DashboardContent
      email={user.email ?? "unknown"}
      profile={profile}
    />
  );
}
