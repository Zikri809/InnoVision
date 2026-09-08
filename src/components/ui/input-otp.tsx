"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { OTPInput, OTPInputContext } from "input-otp"

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "cn-input-otp flex items-center has-disabled:opacity-50",
        containerClassName
      )}
      spellCheck={false}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn(
        "flex items-center rounded-none has-aria-invalid:border-destructive has-aria-invalid:ring-1 has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

/**
 * Clay tile skin (base-lyra drop + MASTER.md re-skin, matched to the
 * approved redesign preview): warm cream tiles (bg-background +
 * border-border), orange border + hard offset shadow once a character
 * lands, orange border + caret while active. Upstream data-* attributes,
 * aria-invalid wiring, and the fake caret are preserved.
 */
function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        // Fluid width: 48px max, shrinking on narrow surfaces so a 6-tile
        // row + separator always fits the dialog/drawer content box and
        // centers instead of clipping the right edge. Height stays 52px
        // for the touch target.
        "relative flex h-13 w-[min(44px,11.5vw)] items-center justify-center rounded-[14px] border-[3px] border-border bg-background font-mono text-xl font-bold uppercase text-foreground transition-all outline-none aria-invalid:border-destructive dark:bg-input/30",
        char && "border-primary bg-card shadow-[0_3px_0_var(--border)]",
        "data-[active=true]:z-10 data-[active=true]:border-primary",
        className
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-7 w-[3px] animate-caret-blink rounded-full bg-primary duration-1000" />
        </div>
      )}
    </div>
  )
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      className="flex items-center px-0.5"
      role="separator"
      {...props}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
