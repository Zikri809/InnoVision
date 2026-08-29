import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Fredoka, Nunito } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { Toaster } from "@/components/ui/toaster";
import { THEME_INIT_SCRIPT } from "@/lib/theme/theme";
import "./globals.css";
import { cn } from "@/lib/utils";

// Clay design system type pairing: Fredoka (display) + Nunito (body).
// See design-system/innovision/MASTER.md.
const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-heading",
});

const nunito = Nunito({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "InnoVision",
  description: "AI-powered gesture quizzes with face verification",
};

export const viewport = {
  // Matches the clay background so mobile chrome + scrollbars blend in.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fff7ed" },
    { media: "(prefers-color-scheme: dark)", color: "#1c0f08" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={cn("h-full", "antialiased", fredoka.variable, nunito.variable)}
      suppressHydrationWarning
    >
      <head>
        {/* Pre-hydration theme boot (AX-1): applies the stored/system `.dark`
            class before first paint so there is no flash-of-light. Script
            source lives in src/lib/theme/theme.ts (single CSP-hash surface;
            CSP is Report-Only today — hash before enforcing). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          {children}
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
