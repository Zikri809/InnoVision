"use server";

import { cookies } from "next/headers";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_COOKIE_NAME, type Locale } from "@/i18n/config";
import { createServerActionClient } from "@/lib/supabase/server";

/** Read the current active locale from cookies or default. */
export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const val = cookieStore.get(LOCALE_COOKIE_NAME)?.value as Locale | undefined;
  if (val && (SUPPORTED_LOCALES as readonly string[]).includes(val)) {
    return val;
  }
  return DEFAULT_LOCALE;
}

/** Set the active locale in cookies and optionally update profiles.locale if authenticated. */
export async function setLocale(locale: Locale): Promise<void> {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    return;
  }

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE_NAME, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  // If user is logged in, attempt to persist preference to profiles table
  try {
    const supabase = await createServerActionClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      await supabase
        .from("profiles")
        .update({ locale })
        .eq("id", user.id);
    }
  } catch {
    // Non-blocking: unauthenticated or DB sync error shouldn't fail cookie update
  }
}
