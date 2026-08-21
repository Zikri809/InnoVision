"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME } from "@/i18n/config";
import { tFor } from "@/lib/i18n/messages";

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
    // Localized generic message: raw Supabase errors are English-only, and a
    // generic response also avoids revealing whether the email or the
    // password was wrong.
    console.error("signInWithPassword error:", error.message);
    const cookieStore = await cookies();
    const t = tFor(cookieStore.get(LOCALE_COOKIE_NAME)?.value === "ms" ? "ms" : "en");
    return { error: t("authErrors.loginFailed") };
  }

  return {};
}
