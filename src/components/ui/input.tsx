import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

// Clay input: chunky radius, 3px border, warm orange focus ring.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-2xl border-[3px] border-input bg-card px-4 py-2 font-sans text-base font-semibold text-foreground transition-[border-color,box-shadow] duration-[180ms] outline-none placeholder:font-semibold placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
