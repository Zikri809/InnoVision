"use client"

import * as React from "react"
import { CalendarClock, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// Clay datetime picker: the shadcn "DateTimePicker" pattern (Calendar in a
// popover + time fields) composed from the app's Base UI popover and clay
// button/input. Value contract mirrors <input type="datetime-local"> —
// local-time "YYYY-MM-DDTHH:mm" or "" — so existing form payloads and
// validation are untouched.

/** Format a Date as a datetime-local string (local wall time, minute precision). */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** Display string like "12 Dec 2026, 14:30" (locale-aware). */
function formatValue(value: string, locale: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d)
}

function partsOf(value: string): { day: Date | undefined; hh: string; mm: string } {
  if (!value) return { day: undefined, hh: "", mm: "" }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return { day: undefined, hh: "", mm: "" }
  return {
    day: d,
    hh: String(d.getHours()).padStart(2, "0"),
    mm: String(d.getMinutes()).padStart(2, "0"),
  }
}

export function DateTimePicker({
  value,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  placeholder,
  className,
  buttonClassName,
}: {
  /** datetime-local string ("YYYY-MM-DDTHH:mm") or "" for unset. */
  value: string
  /** Receives datetime-local strings ("") when cleared. */
  onChange: (value: string) => void
  disabled?: boolean
  id?: string
  /** Accessible name for the trigger (caller supplies localized copy). */
  ariaLabel: string
  placeholder?: string
  className?: string
  buttonClassName?: string
}) {
  const localeTag = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en"
  const locale = localeTag === "ms" ? "ms-MY" : "en-MY"
  const { day, hh, mm } = partsOf(value)
  const [clock, setClock] = React.useState({ hh, mm })

  // Keep local time fields in sync when the value changes externally
  // (e.g. dialog reset or sibling field logic).
  React.useEffect(() => {
    setClock({ hh, mm })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const emit = (day: Date | undefined, hh: string, mm: string) => {
    if (!day) {
      onChange("")
      return
    }
    const d = new Date(day)
    d.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0)
    onChange(toLocalInput(d))
  }

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) return
    // Keep any already-typed time; default to 09:00 so a fresh pick is never
    // midnight-surprise.
    const nextHh = clock.hh || "09"
    const nextMm = clock.mm || "00"
    setClock({ hh: nextHh, mm: nextMm })
    emit(day, nextHh, nextMm)
  }

  const handleClock = (part: "hh" | "mm", raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 2)
    const capped = part === "hh" ? Math.min(Number(digits) || 0, 23) : Math.min(Number(digits) || 0, 59)
    const next = { ...clock, [part]: digits ? String(capped).padStart(2, "0") : "" }
    setClock(next)
    if (day) emit(day, next.hh, next.mm)
  }

  const hasValue = Boolean(value)

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              id={id}
              disabled={disabled}
              aria-label={ariaLabel}
              className={cn("justify-start font-bold", buttonClassName)}
            >
              <CalendarClock className="size-4 text-primary" aria-hidden="true" />
              <span className={cn("truncate", !hasValue && "font-semibold text-muted-foreground")}>
                {hasValue ? formatValue(value, locale) : (placeholder ?? "—")}
              </span>
              <ChevronDown className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          }
        />
        <PopoverContent className="w-auto p-2">
          <Calendar
            mode="single"
            selected={day}
            defaultMonth={day}
            onSelect={handleDaySelect}
            disabled={{ after: new Date(2100, 0, 1) }}
          />
          <div className="flex items-center justify-center gap-1.5 border-t-[3px] border-border/40 pt-2.5">
            <Input
              type="text"
              inputMode="numeric"
              value={clock.hh}
              onChange={(e) => handleClock("hh", e.target.value)}
              placeholder="HH"
              aria-label={`${ariaLabel} — hours`}
              disabled={disabled}
              className="h-11 max-sm:h-11 w-14 rounded-xl px-2 text-center text-base font-bold"
            />
            <span aria-hidden="true" className="text-sm font-extrabold text-muted-foreground">:</span>
            <Input
              type="text"
              inputMode="numeric"
              value={clock.mm}
              onChange={(e) => handleClock("mm", e.target.value)}
              placeholder="MM"
              aria-label={`${ariaLabel} — minutes`}
              disabled={disabled}
              className="h-11 max-sm:h-11 w-14 rounded-xl px-2 text-center text-base font-bold"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export { toLocalInput }
