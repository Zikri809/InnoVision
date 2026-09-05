"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"

import { cn } from "@/lib/utils"
import { Check } from "lucide-react"

// Clay checkbox: chunky rounded box, 3px border, orange checked state.
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // Hit-slop ::after (globals.css) extends the 24px box to a 44px+ tap
        // target without changing the visual size (plan W8).
        "hit-slop peer relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg border-[3px] border-input bg-card transition-[background-color,border-color,box-shadow] duration-[180ms] outline-none group-has-disabled/field:opacity-50 focus-visible:ring-4 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current [&>svg]:size-4"
      >
        <Check strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
