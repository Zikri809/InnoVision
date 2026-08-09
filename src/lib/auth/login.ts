"use server";

import { createServerActionClient } from "@/lib/supabase/server";

export interface LoginResult {
  error?: string;
}

export async function login({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<LoginResult> {
  const supabase = await createServerActionClient();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  return {};
}
