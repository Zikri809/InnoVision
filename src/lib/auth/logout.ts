"use server";

import { createServerActionClient } from "@/lib/supabase/server";

export async function logout(): Promise<void> {
  const supabase = await createServerActionClient();
  await supabase.auth.signOut();
}
