"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Topbar nav link with an active (current-page) state. A link is "active" when
 * the current pathname starts with its href (so nested routes like a class
 * detail still highlight "My Classes"). Active = clay pill with primary tint,
 * 3px border, and offset shadow; sets aria-current="page" for screen readers.
 */
export function AppNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-xl px-3.5 py-2 text-[15px] font-extrabold transition-[background-color,color,box-shadow,border-color] duration-150",
        active
          ? "border-[3px] border-primary/40 bg-orange-100 text-primary shadow-[0_3px_0_var(--border)]"
          : "border-[3px] border-transparent text-muted-foreground hover:bg-orange-100/70 hover:text-primary",
      )}
    >
      {label}
    </Link>
  );
}
