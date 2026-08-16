import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Clay button system: chunky radius, 3px borders, hard offset "3D base" shadow,
// soft-press on active. See design-system/innovision/MASTER.md.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-2xl border-[3px] font-sans font-extrabold whitespace-nowrap transition-[transform,box-shadow,background-color,color] duration-[180ms] ease-out outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[0_4px_0_var(--primary-deep)] hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--primary-deep)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--primary-deep)]",
        accent:
          "border-transparent bg-accent text-accent-foreground shadow-[0_4px_0_var(--accent-deep)] hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--accent-deep)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--accent-deep)]",
        outline:
          "border-border bg-card text-foreground shadow-[0_4px_0_var(--border)] hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)]",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground shadow-[0_4px_0_var(--primary-deep)] hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--primary-deep)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--primary-deep)]",
        ghost:
          "border-transparent bg-transparent text-foreground hover:bg-muted active:translate-y-0.5",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-[0_4px_0_#991b1b] hover:-translate-y-0.5 hover:shadow-[0_6px_0_#991b1b] active:translate-y-0.5 active:shadow-[0_1px_0_#991b1b]",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 text-base",
        xs: "h-8 gap-1.5 rounded-xl px-3 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 rounded-xl px-4 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 rounded-2xl px-7 text-base",
        icon: "size-11",
        "icon-xs": "size-8 rounded-xl [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9 rounded-xl",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
