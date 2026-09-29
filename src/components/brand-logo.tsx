import Image from "next/image";
import { cn } from "@/lib/utils";

/** Team ribbon mark, with a consistent frame and the app's own wordmark. */
export function BrandLogo({
  size = "default",
  wordmarkClassName,
}: {
  size?: "small" | "default" | "large";
  wordmarkClassName?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "grid shrink-0 place-items-center border-[3px] border-primary/35 bg-card shadow-[0_3px_0_var(--primary-deep)] dark:bg-[#3b1e10]",
          size === "small" ? "h-10 w-10 rounded-[12px] p-1" : size === "large" ? "h-14 w-14 rounded-[16px] p-1.5" : "h-12 w-12 rounded-[12px] p-1.5",
        )}
      >
        <Image
          src="/brand/easy2u-mark.webp"
          alt=""
          width={960}
          height={524}
          sizes="44px"
          className="h-auto w-full drop-shadow-[0_1px_1px_rgba(124,45,18,0.25)]"
        />
      </span>
      <span
        className={cn(
          "font-heading font-semibold tracking-tight text-foreground",
          size === "small" ? "text-[21px]" : size === "large" ? "text-[28px]" : "text-[23px]",
          wordmarkClassName,
        )}
      >
        Easy2U
      </span>
    </span>
  );
}
