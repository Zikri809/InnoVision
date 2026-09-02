# AGENTS.md — Working Agreement for Coding Agents

## UI Component Sourcing (shadcn-first — follow this order)

1. **Check the official shadcn registry first.** This project runs the
   **Base UI** base (`"style": "base-lyra"` in `components.json`; official
   shadcn made Base UI its default in July 2026). Before hand-writing any
   interactive component, check whether official shadcn ships it:
   - Docs via Context7: library ID `/shadcn-ui/ui` (e.g. query the date-picker
     or calendar docs).
   - Registry JSON: `https://ui.shadcn.com/r/styles/base-lyra/<component>.json`.
2. **Install with the CLI** — it serves Base UI code for this repo's style:
   ```bash
   npx shadcn@latest add <component>          # e.g. tooltip, tabs, alert-dialog
   npx shadcn@latest add <component> --dry-run # preview first
   ```
   No custom registries are configured in `components.json`; do not add
   third-party ones (basecn etc.) — the official registry covers Base UI.
3. **Then apply the clay re-skin** to the dropped file in
   `src/components/ui/` — 3px borders, chunky radii, offset shadows, bold
   Nunito text (see `design-system/innovision/MASTER.md` for the token
   values). Registry structure and clay styling are separate concerns: keep
   the upstream interaction architecture intact.
4. **Do NOT hand-roll interaction-heavy components** (calendars, popovers,
   comboboxes, dialogs-with-focus-traps, carousels, tabs). Upstream versions
   are accessibility-tested and maintained; ours rot. Exemplar of the correct
   result: `src/components/ui/calendar.tsx` (official base-lyra calendar +
   clay skin) and `src/components/ui/datetime-picker.tsx` (composition of
   Popover + Calendar per the official date-picker docs pattern).
5. **Hand-writing is fine only for** pure-styling wrappers (card, label) and
   app-specific compositions no registry ships (question-image-field,
   bulk-import-dialog).

### Contract rules when porting registry components

- Keep upstream `data-*` attributes and accessibility wiring intact; add to
  them, never remove.
- `CalendarDayButton` must expose `data-day` in **stable ISO format**
  (`toLocaleDateString("en-CA")`), NOT locale-dependent strings —
  `e2e/helpers-datetime.ts` targets `[data-day="YYYY-MM-DD"]`.
- Date/datetime state in forms uses the **`datetime-local` string contract**
  (`"YYYY-MM-DDTHH:mm"` / `""`), not `Date` objects — server payloads and
  validation depend on it (see `DateTimePicker`).
- Component accessible names that e2e specs rely on (`getByRole("button", {
  name: /.../ })`, `getByLabel`) must survive refactors — grep `e2e/` before
  changing copy or markup of interactive elements.

## Theme & Styling Facts (don't relitigate)

- `--primary-foreground` is deep brown on orange **by design** (AX-2): white
  on `#f97316` fails WCAG at 2.8:1; the brown passes at ~7:1. Do not "fix"
  dark text on primary buttons.
- Amber/warning elements in dark mode use the established pattern:
  `dark:border-amber-500/40 dark:bg-amber-500/10+ dark:text-amber-200/300`
  (see class-detail-client). Never leave light-only amber classes.
- The clay rules in MASTER.md are binding: 3px borders, hard offset shadows,
  chunky radii, warm shadows (never pure gray/black).

## Docs Map

- `design-system/innovision/MASTER.md` — clay tokens, component specs,
  anti-patterns, pre-delivery checklist.
- `docs/ARCHITECTURE.md` — runtime topology, security model, feature
  walkthroughs, i18n, testing map.
- `docs/TESTING.md` — how to run unit/e2e suites; e2e specs are
  invite-gated (`LECTURER_INVITE_CODE`) and need a live Supabase seam.
