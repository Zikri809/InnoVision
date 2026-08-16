import * as React from "react"

import { cn } from "@/lib/utils"

// Clay textarea: chunky radius, 3px border, warm orange focus ring.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-2xl border-[3px] border-input bg-card px-4 py-3 font-sans text-base font-semibold text-foreground transition-[border-color,box-shadow] duration-[180ms] outline-none placeholder:font-semibold placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
