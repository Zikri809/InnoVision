# Quiz Builder Metadata Editing (Title, Mode, Time Limit) — Architecture & Implementation Plan

**Status**: IMPLEMENTED (PATCH /api/quizzes/[id], in-place edit + regenerate modals — commit d732dab; E15 covers it). Plan kept as the design record. (Critiqued & Hardened by 4 Review Subagents)  
**Target Module**: Quiz Builder (`src/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client.tsx`), Quiz API (`src/app/api/quizzes/[id]/route.ts`), Class Quizzes API (`src/app/api/classes/[id]/quizzes/route.ts`), Quiz Validation (`src/lib/quizzes/validation.ts`)  
**Dependencies**: `supabase/migrations/0004_quizzes.sql`, `supabase/migrations/0007_ai_generation.sql`, `src/lib/http.ts`, `src/lib/quizzes/guards.ts`  
**UI Rewrite Alignment**: Spec written with strict separation of backend invariants, pure utility functions, and clean component interfaces so it remains completely resilient to upcoming UI refactors.

---

## 1. Executive Summary

Lecturers require the ability to update a quiz's **Title**, **Mode** (`practice` $\leftrightarrow$ `assessment`), and **Time Limit** (hours & minutes) while the quiz is in `draft` status.

The interaction pattern is a **Hybrid UX Architecture**:
1. **Inline Title Editing (Fast Path)**: Clicking the `<h1>` title or its adjacent pencil button activates in-place editing (<kbd>Enter</kbd> to save, <kbd>Esc</kbd> to cancel).
2. **Quiz Settings Modal (`EditQuizDialog`) (Full Control Path)**: Clicking the Settings button (`Settings2` icon) or interactive metadata pills opens a controlled dialog for simultaneous updates to **Title**, **Mode**, and **Time Limit**.

### 1.1 Verified Current State vs. Gaps Matrix

| Item | Status | Code Location | Resolution |
| :--- | :--- | :--- | :--- |
| **Inline Title Editing** | Already implemented | `quiz-builder-client.tsx:109-194`, `:391-474` | Retain as-is; add mutual exclusion with settings modal |
| **Mode / Time Limit UI** | Read-only pills | `quiz-builder-client.tsx:475-491` | Transform into interactive `<button>` affordances opening modal |
| **`PATCH /api/quizzes/[id]`** | Partial support | `src/app/api/quizzes/[id]/route.ts:24-83` | Use `buildQuizUpdates()`, `.maybeSingle()`, and trigger/CHECK error mapping |
| **DB Time Limit Cap (7,200s)** | In DB CHECK | `0004_quizzes.sql:40` | Authoritative ceiling (2 hours / 120 minutes) |
| **Zod Schema 72h Mismatch** | **Bug (72h vs 2h)** | `src/lib/quizzes/validation.ts:95` | Reconcile with `TIME_LIMIT_MAX_SEC = 7200` |
| **Create Form 72h Mismatch** | **Bug (max=72)** | `class-detail-client.tsx:241-251` | Reconcile hours input `max={HOURS_MAX}` (`2`) |
| **Practice Mode Time Wipe** | Missing in route | `src/app/api/quizzes/[id]/route.ts:61-68` | Enforce `time_limit_sec = null` in route + DB CHECK backstop |
| **Create Route Sanitization** | Missing in create | `src/app/api/classes/[id]/quizzes/route.ts:54-65` | Force `time_limit_sec = null` when `mode === "practice"` |
| **DB Practice Untimed CHECK** | Missing in DB | `supabase/migrations/0004_quizzes.sql` | Add migration `0014_quiz_practice_untimed.sql` with trigger disable/enable |
| **Draft Immutability Backstop** | Enforced in DB | `0007_ai_generation.sql:44-52` (live trigger) | Authoritative trigger `quiz_status_transition` blocks non-draft edits |

---

## 2. Deep-Dive Subagent Audit & Architectural Hardening

### 2.1 Backend & Security Review (Subagent 1)
1. **Migration 0014 Trigger Bypass Requirement**:
   Directly executing `UPDATE public.quizzes SET time_limit_sec = null WHERE mode = 'practice'` in a migration would fail if any legacy live/closed rows have `time_limit_sec IS NOT NULL`, because the active `quiz_status_transition` trigger (`0007_ai_generation.sql:44-52`) blocks metadata updates on non-draft rows.
   * **Fix**: The migration must wrap data sanitization inside `ALTER TABLE public.quizzes DISABLE TRIGGER quiz_status_transition;` and `ENABLE TRIGGER` before adding the constraint.
2. **Concurrent DELETE PostgREST Error (`.single()` vs `.maybeSingle()`)**:
   In `PATCH /api/quizzes/[id]`, using `.single()` returns `PGRST116` (503 `internal`) if the quiz was deleted concurrently after `requireQuizOwner` passed.
   * **Fix**: Use `.maybeSingle()` and return `notFound()` (404) if `!quiz`.
3. **Database Trigger & CHECK Error Mapping**:
   Catch PostgreSQL exceptions in `PATCH /api/quizzes/[id]` and map them accurately:
   - `error.message.includes("quiz_not_draft_edit")` $\rightarrow$ `notDraft()` (409 Conflict).
   - `error.message.includes("quizzes_practice_untimed")` or check constraint $\rightarrow$ `invalidBody("Invalid quiz data.")` (400 Bad Request).
   - Unhandled errors $\rightarrow$ `internalError()` (503).
4. **Create Route Default Sanitization**:
   In `POST /api/classes/[id]/quizzes`, if `mode` defaults to `"practice"`, force `time_limit_sec = null` before insertion so it never violates the new CHECK constraint.

### 2.2 Frontend Architecture & React 19 State Sync Review (Subagent 2)
1. **Base UI Animation vs. Gated Unmounting**:
   Placing `{open && quiz && <EditQuizForm />}` at the top level around `<DialogContent>` destroys the popup DOM node before the exit transition (`data-closed:zoom-out-95`) finishes.
   * **Fix**: Mount `<DialogContent>` unconditionally and place the form inside: `<DialogContent>{open && quiz && <EditQuizForm key={`${quiz.id}-${open}`} ... />}</DialogContent>`.
2. **Unconditional Stashing on Mode Change**:
   When toggling `assessment` $\rightarrow$ `practice`, unconditionally stash `{ hours, minutes }` into a ref (`lastAssessmentHm.current`). On `practice` $\rightarrow$ `assessment`, restore from stash if present, otherwise restore initial DB value.
3. **True No-Op Detection**:
   Compute a clean delta object (`patch`). If `Object.keys(patch).length === 0`, close the modal immediately without issuing a network request.
4. **Sub-Minute Initial Stored Limits (e.g. 45s)**:
   Distinguish between untimed (`time_limit_sec == null`) and sub-minute (`0 < time_limit_sec < 60`). Show a prominent amber warning banner (`role="status"`). If user only edits the title, omit `timeLimitSec` so the sub-minute limit is preserved on the server.
5. **Mutual Exclusion**:
   Opening the settings dialog cancels any active inline title editing (`cancelTitleEdit()`). Settings triggers are disabled while `savingTitle`, `saving`, or `publishing` is true.

### 2.3 UI/UX, Design System & Accessibility Review (Subagent 3)
1. **InnoVision 3px Claymorphic Tokens**:
   All modal separators, badges, and card borders must strictly use `border-[3px]` with `border-border/40` (never 1px or 2px hairlines).
2. **Dark-Mode Contrast Compliance (WCAG 1.4.3 AA)**:
   Ensure `MODE_CLASS` includes dark-mode token overrides (`dark:bg-blue-950/40 dark:text-blue-300`, `dark:bg-emerald-950/40 dark:text-emerald-300`) to guarantee $\ge 4.5:1$ contrast ratio.
3. **Focus Restoration Fallback**:
   If a trigger element is unmounted on save (e.g. the time-limit pill disappears when a quiz is made untimed, or the quiz is published in another tab), provide a fallback focusing `settingsBtnRef` or `headingRef` to prevent focus falling to `document.body` (WCAG 2.4.3).
4. **Form Grouping & Key Sanitization**:
   Wrap Time Limit inputs in a `<fieldset>` with `<legend>`, use `Label sr-only` for Hours and Minutes, connect helper text via `aria-describedby`, and block non-numeric characters (`e`, `E`, `+`, `-`, `.`).
5. **Touch Targets (WCAG 2.5.5 / 2.5.8)**:
   Buttons use minimum `size-9` (36px) with hit expansion (`before:absolute before:-inset-1`) for touch accessibility.

### 2.4 QA, Verification & Test Strategy Review (Subagent 4)
1. **`vitest.config.ts` Coverage Include**:
   Add `"src/lib/quizzes/**"` to `coverage.include` (lines 13–26) in addition to setting per-file thresholds for `updates.ts`, `time-limit.ts`, and `validation.ts`.
2. **Standardized Test Taxonomy**:
   Formalize all tests into `U-M1..U-M18` (Unit), `I-M1..I-M12` (Integration), `D26..D28` / `MED-4b` (Direct SQL), and `E15-1..E15-10` (Playwright E2E).
3. **E2E Response Interception**:
   In `e15-quiz-metadata-edit.spec.ts`, assert stored state updates via `page.waitForResponse(...)` on the `PATCH` network call (replacing non-existent `GET /api/quizzes/[id]` calls).
4. **Playwright `e10` Stale Selector Fix**:
   Replace obsolete `getByLabel("Time limit (seconds)")` in `e10-timer-expiry.spec.ts` with direct PATCH evaluation for sub-minute test timing.

---

## 3. Database Migration Specification

### Migration `0014_quiz_practice_untimed.sql`
```sql
-- InnoVision — Migration 0014: Practice quizzes untimed constraint
-- Depends on: 0004_quizzes.sql, 0007_ai_generation.sql

-- 1. Temporarily disable the draft edit-lock trigger to sanitize legacy rows safely
alter table public.quizzes disable trigger quiz_status_transition;

update public.quizzes
   set time_limit_sec = null
 where mode = 'practice'
   and time_limit_sec is not null;

alter table public.quizzes enable trigger quiz_status_transition;

-- 2. Practice quizzes are untimed — authoritative invariant across all write paths
alter table public.quizzes
  add constraint quizzes_practice_untimed
  check (mode <> 'practice' or time_limit_sec is null);
```

---

## 4. Pure Architecture & Shared Modules

### 4.1 Schema Constants & Validation (`src/lib/quizzes/validation.ts`)
```typescript
import { z } from "zod";

export const OPTION_MIN = 1;
export const OPTION_MAX = 500;
export const PROMPT_MAX = 2000;
export const TITLE_MAX = 200;
export const EXPLANATION_MAX = 2000;
export const MCQ_OPTIONS_MIN = 2;
export const MCQ_OPTIONS_MAX = 5;
export const TRUE_FALSE_OPTIONS = 2;

/**
 * Time-limit bounds. null = untimed; 1..7200 = timed; 0 is invalid.
 * Stays in lockstep with the DB CHECK in supabase/migrations/0004_quizzes.sql:40.
 */
export const TIME_LIMIT_MIN_SEC = 1;
export const TIME_LIMIT_MAX_SEC = 7200; // 2 hours (120 minutes)

const QuizFieldsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(TITLE_MAX, `Title must be at most ${TITLE_MAX} characters.`),
  mode: z.enum(["practice", "assessment"]),
  timeLimitSec: z
    .number({ invalid_type_error: "Time limit must be a number of seconds." })
    .int("Time limit must be a whole number of seconds.")
    .min(TIME_LIMIT_MIN_SEC, "Time limit must be at least 1 second.")
    .max(TIME_LIMIT_MAX_SEC, "Time limit must be at most 2 hours (120 minutes).")
    .nullable()
    .optional(),
});

export const CreateQuizSchema = QuizFieldsSchema.extend({
  mode: z.enum(["practice", "assessment"]).default("practice"),
});
export type CreateQuizInput = z.infer<typeof CreateQuizSchema>;

export const UpdateQuizSchema = QuizFieldsSchema.partial();
export type UpdateQuizInput = z.infer<typeof UpdateQuizSchema>;
```

---

### 4.2 Pure Update Builder (`src/lib/quizzes/updates.ts`)
```typescript
import type { QuizMode } from "@/lib/types/aliases";

export interface QuizMetadataPatch {
  title?: string;
  mode?: QuizMode;
  timeLimitSec?: number | null;
}

export interface QuizUpdateColumns {
  title?: string;
  mode?: QuizMode;
  time_limit_sec?: number | null;
}

/**
 * Maps a validated PATCH payload to database update columns.
 * Enforces the business invariant that practice quizzes are untimed (time_limit_sec = null).
 */
export function buildQuizUpdates(
  input: QuizMetadataPatch,
  currentMode: QuizMode,
): QuizUpdateColumns {
  const updates: QuizUpdateColumns = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.mode !== undefined) updates.mode = input.mode;
  if (input.timeLimitSec !== undefined) updates.time_limit_sec = input.timeLimitSec;

  const effectiveMode = input.mode ?? currentMode;
  if (effectiveMode === "practice") {
    updates.time_limit_sec = null;
  }
  return updates;
}
```

---

### 4.3 Pure Time Limit Conversions (`src/lib/quizzes/time-limit.ts`)
```typescript
import { TIME_LIMIT_MAX_SEC } from "./validation";

export const HOURS_MAX = 2; // TIME_LIMIT_MAX_SEC / 3600
export const MINUTES_MAX = 59;

/** [hours, minutes] pair from stored seconds (clamped to the max). */
export function secondsToHm(sec: number | null): { hours: number; minutes: number } {
  if (sec == null) return { hours: 0, minutes: 0 };
  if (sec > TIME_LIMIT_MAX_SEC) {
    console.warn(`time_limit_sec ${sec} exceeds ${TIME_LIMIT_MAX_SEC}; clamping for display.`);
  }
  const capped = Math.min(sec, TIME_LIMIT_MAX_SEC);
  return { hours: Math.floor(capped / 3600), minutes: Math.floor((capped % 3600) / 60) };
}

/**
 * Lossless serialization of hours/minutes pair to seconds.
 * Schema (Zod .max) is the single validation boundary. Returns null for blank/0h0m.
 */
export function hmToSeconds(hours: number, minutes: number): number | null {
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const h = Math.max(0, Math.trunc(hours));
  const m = Math.max(0, Math.trunc(minutes));
  if (h === 0 && m === 0) return null;
  return h * 3600 + m * 60;
}
```

---

### 4.4 Centralized Labels & Styling Tokens (`src/lib/quizzes/labels.ts`)
```typescript
import type { QuizMode } from "@/lib/types/aliases";

export type QuizStatus = "draft" | "live" | "closed";

export const STATUS_LABEL: Record<QuizStatus, string> = {
  draft: "Draft",
  live: "Live",
  closed: "Closed",
};

export const STATUS_CLASS: Record<QuizStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  live: "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  closed: "border-destructive/40 bg-destructive/10 text-destructive dark:border-destructive/50 dark:bg-destructive/20 dark:text-destructive",
};

export const MODE_LABEL: Record<QuizMode, string> = {
  practice: "Practice",
  assessment: "Assessment",
};

export const MODE_CLASS: Record<QuizMode, string> = {
  practice:
    "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  assessment:
    "border-accent/40 bg-blue-100 text-accent dark:border-blue-700/50 dark:bg-blue-950/40 dark:text-blue-300",
};
```

---

## 5. API Route Handlers

### 5.1 `PATCH /api/quizzes/[id]/route.ts`
```typescript
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { UpdateQuizSchema } from "@/lib/quizzes/validation";
import { buildQuizUpdates } from "@/lib/quizzes/updates";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notDraft,
  notFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = UpdateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid quiz data."));
  }

  const { title, mode, timeLimitSec } = parsed.data;
  if (title === undefined && mode === undefined && timeLimitSec === undefined) {
    return invalidBody("No editable fields provided.");
  }

  const updates = buildQuizUpdates({ title, mode, timeLimitSec }, owner.quiz.mode);

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .update(updates)
    .eq("id", id)
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .maybeSingle();

  if (error) {
    console.error("Update quiz error:", error);
    if (error.message?.includes("quiz_not_draft_edit")) {
      return notDraft();
    }
    if (
      error.message?.includes("quizzes_practice_untimed") ||
      error.message?.includes("quizzes_time_limit_sec_check") ||
      error.message?.includes("quizzes_title_check") ||
      error.message?.includes("check constraint")
    ) {
      return invalidBody("Invalid quiz data.");
    }
    return internalError("Could not update the quiz right now.");
  }

  if (!quiz) {
    return notFound();
  }

  return NextResponse.json({ quiz });
}
```

---

### 5.2 `POST /api/classes/[id]/quizzes/route.ts` (Sanitized Insert)
```typescript
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireClassOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { CreateQuizSchema } from "@/lib/quizzes/validation";
import { checkSameOrigin, firstIssueMessage, internalError, invalidBody, invalidJson, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id: classId } = await params;

  if (!isUuid(classId)) {
    return notFound();
  }

  const owner = await requireClassOwner(supabase, classId);
  if (!owner.ok) return owner.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = CreateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid quiz data."));
  }

  const { title, mode, timeLimitSec } = parsed.data;
  const effectiveTimeLimitSec = mode === "practice" ? null : (timeLimitSec ?? null);

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .insert({
      class_id: classId,
      created_by: owner.userId,
      title,
      mode,
      time_limit_sec: effectiveTimeLimitSec,
      status: "draft",
    })
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .single();

  if (error) {
    console.error("Create quiz error:", error);
    if (error.message?.includes("quizzes_practice_untimed") || error.message?.includes("time_limit")) {
      return invalidBody("Invalid quiz configuration.");
    }
    return internalError("Could not create the quiz right now.");
  }

  return NextResponse.json({ quiz }, { status: 201 });
}
```

---

## 6. Frontend Component Implementation

### 6.1 `EditQuizDialog` (`src/components/quiz/edit-quiz-dialog.tsx`)
```tsx
"use client";

import { useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TITLE_MAX } from "@/lib/quizzes/validation";
import { HOURS_MAX, MINUTES_MAX, hmToSeconds, secondsToHm } from "@/lib/quizzes/time-limit";
import { MODE_LABEL } from "@/lib/quizzes/labels";
import type { QuizInfo } from "@/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client";
import type { QuizMode } from "@/lib/types/aliases";
import type { QuizMetadataPatch } from "@/lib/quizzes/updates";

export interface EditQuizDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quiz: QuizInfo;
  onSuccess?: () => void;
  onError?: (status: number, message: string) => void;
}

function EditQuizForm({
  quiz,
  onClose,
  onSuccess,
  onError,
}: {
  quiz: QuizInfo;
  onClose: () => void;
  onSuccess?: () => void;
  onError?: (status: number, message: string) => void;
}) {
  const [title, setTitle] = useState(quiz.title);
  const [mode, setMode] = useState<QuizMode>(quiz.mode);

  const initialHm = secondsToHm(quiz.time_limit_sec);
  const [hours, setHours] = useState<string>(() =>
    quiz.time_limit_sec != null ? String(initialHm.hours) : ""
  );
  const [minutes, setMinutes] = useState<string>(() => {
    if (quiz.time_limit_sec == null) return "";
    if (quiz.time_limit_sec > 0 && quiz.time_limit_sec < 60) return "1";
    return String(initialHm.minutes);
  });

  const [timeTouched, setTimeTouched] = useState(false);
  const lastAssessmentHm = useRef<{ hours: string; minutes: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  const isSubMinuteInitial =
    quiz.time_limit_sec != null &&
    quiz.time_limit_sec > 0 &&
    quiz.time_limit_sec < 60;

  function blockNonNumeric(e: React.KeyboardEvent<HTMLInputElement>) {
    if (["e", "E", "+", "-", "."].includes(e.key)) {
      e.preventDefault();
    }
  }

  function handleModeChange(newMode: QuizMode) {
    if (newMode === mode) return;
    if (newMode === "practice") {
      lastAssessmentHm.current = { hours, minutes };
      setMode("practice");
    } else {
      if (lastAssessmentHm.current !== null) {
        setHours(lastAssessmentHm.current.hours);
        setMinutes(lastAssessmentHm.current.minutes);
      } else if (quiz.time_limit_sec != null) {
        const hm = secondsToHm(quiz.time_limit_sec);
        setHours(String(hm.hours));
        setMinutes(String(hm.minutes));
      } else {
        setHours("");
        setMinutes("");
      }
      setMode("assessment");
    }
  }

  function handleHoursChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setTimeTouched(true);
    if (val === "") {
      setHours("");
      return;
    }
    const num = Number(val);
    if (Number.isNaN(num)) return;
    const clamped = Math.max(0, Math.min(HOURS_MAX, Math.trunc(num)));
    setHours(String(clamped));
    if (clamped === HOURS_MAX) {
      setMinutes("");
    }
  }

  function handleMinutesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setTimeTouched(true);
    if (val === "") {
      setMinutes("");
      return;
    }
    const num = Number(val);
    if (Number.isNaN(num)) return;
    const clamped = Math.max(0, Math.min(MINUTES_MAX, Math.trunc(num)));
    setMinutes(String(clamped));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving || submitLock.current) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Quiz title is required.");
      return;
    }
    if (trimmedTitle.length > TITLE_MAX) {
      setError(`Quiz title must be at most ${TITLE_MAX} characters.`);
      return;
    }

    const patch: QuizMetadataPatch = {};
    if (trimmedTitle !== quiz.title) {
      patch.title = trimmedTitle;
    }
    if (mode !== quiz.mode) {
      patch.mode = mode;
    }

    if (mode === "assessment") {
      const isBlank = hours.trim() === "" && minutes.trim() === "";
      const effectiveSec = isBlank
        ? null
        : hmToSeconds(Number(hours) || 0, Number(minutes) || 0);

      if (mode !== quiz.mode || (timeTouched && effectiveSec !== quiz.time_limit_sec)) {
        patch.timeLimitSec = effectiveSec;
      }
    }

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    submitLock.current = true;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 409) {
          onClose();
          onError?.(409, body.message ?? "Quiz is no longer in draft status.");
          return;
        }
        if (res.status === 404) {
          onClose();
          onError?.(404, body.message ?? "Quiz not found.");
          return;
        }
        setError(body.message ?? body.error ?? "Could not update quiz settings.");
        return;
      }

      onClose();
      onSuccess?.();
    } catch {
      setError("Network error updating quiz settings.");
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  }

  const isHoursMax = Number(hours) === HOURS_MAX && hours !== "";
  const isPractice = mode === "practice";

  return (
    <>
      <DialogHeader className="shrink-0 pb-3 border-b-[3px] border-border/40">
        <DialogTitle className="text-xl font-bold font-heading">
          Quiz settings
        </DialogTitle>
        <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
          Edit title, mode, and time limit. Draft quizzes only.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0 pt-4">
        <div className="flex-1 overflow-y-auto space-y-5 pr-1 py-1">
          {/* Title Field */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-quiz-title" className="text-xs font-extrabold text-foreground">
                Quiz Title
              </Label>
              <span
                aria-hidden="true"
                className="text-[11px] font-bold text-muted-foreground tabular-nums"
              >
                {title.length}/{TITLE_MAX}
              </span>
            </div>
            <Input
              id="edit-quiz-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              disabled={saving}
              placeholder="e.g. Chapter 1 Quiz"
              aria-required="true"
              aria-invalid={Boolean(error && !title.trim())}
            />
          </div>

          {/* Mode Selector */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-quiz-mode" className="text-xs font-extrabold text-foreground">
              Quiz Mode
            </Label>
            <Select
              value={mode}
              onValueChange={(v) => handleModeChange(v as QuizMode)}
              disabled={saving}
            >
              <SelectTrigger id="edit-quiz-mode" className="w-full">
                <SelectValue placeholder="Select mode">
                  {(v) => MODE_LABEL[v as QuizMode] ?? v}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="practice">Practice</SelectItem>
                <SelectItem value="assessment">Assessment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Time Limit Section */}
          <fieldset className="space-y-2" disabled={isPractice || saving}>
            <div className="flex items-center justify-between">
              <legend className="text-xs font-extrabold text-foreground">
                Time Limit {!isPractice && <span className="text-muted-foreground font-normal">(Optional)</span>}
              </legend>
              {isPractice && (
                <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-700/50 rounded-full px-2.5 py-0.5">
                  Untimed in practice mode
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-hours" className="sr-only">
                  Hours
                </Label>
                <Input
                  id="edit-quiz-hours"
                  type="number"
                  min={0}
                  max={HOURS_MAX}
                  step={1}
                  placeholder="0"
                  value={hours}
                  onChange={handleHoursChange}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={blockNonNumeric}
                  disabled={saving || isPractice}
                  aria-describedby="time-limit-helper"
                  className="w-20 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                  hours
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-minutes" className="sr-only">
                  Minutes
                </Label>
                <Input
                  id="edit-quiz-minutes"
                  type="number"
                  min={0}
                  max={MINUTES_MAX}
                  step={1}
                  placeholder="0"
                  value={minutes}
                  onChange={handleMinutesChange}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={blockNonNumeric}
                  disabled={saving || isPractice || isHoursMax}
                  aria-describedby="time-limit-helper"
                  className="w-20 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                  min
                </span>
              </div>
            </div>

            <div aria-live="polite" className="space-y-1">
              <p id="time-limit-helper" className="text-xs font-semibold text-muted-foreground">
                {isPractice
                  ? "Practice quizzes are untimed."
                  : isHoursMax
                    ? "Maximum time limit reached (2 hours). Minutes are set to 0."
                    : "Leave blank for an untimed quiz (maximum 2 hours)."}
              </p>
              {isSubMinuteInitial && !timeTouched && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-xl border-[3px] border-amber-400/50 bg-amber-100/70 p-3 text-xs font-bold text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" aria-hidden="true" />
                  <div>
                    <p className="font-extrabold">Sub-minute time limit ({quiz.time_limit_sec}s)</p>
                    <p className="font-semibold text-amber-900/90 dark:text-amber-300/90">
                      The dialog edits in whole minutes. Modifying time settings will round the limit.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </fieldset>

          {error && (
            <p
              className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="shrink-0 pt-4 border-t-[3px] border-border/40 mt-3 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function EditQuizDialog({
  open,
  onOpenChange,
  quiz,
  onSuccess,
  onError,
}: EditQuizDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] flex flex-col sm:max-w-xl p-6 sm:p-7 overflow-hidden gap-0">
        {open && quiz && (
          <EditQuizForm
            key={`${quiz.id}-${open}`}
            quiz={quiz}
            onClose={() => onOpenChange(false)}
            onSuccess={onSuccess}
            onError={onError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

---

### 6.2 Quiz Builder Hero Integration (`quiz-builder-client.tsx`)
```tsx
// Inside QuizBuilderClient:
const [settingsOpen, setSettingsOpen] = useState(false);
const settingsBtnRef = useRef<HTMLButtonElement>(null);
const headingRef = useRef<HTMLHeadingElement>(null);

function handleDialogClose(open: boolean) {
  setSettingsOpen(open);
  if (!open) {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        if (isDraft && settingsBtnRef.current) {
          settingsBtnRef.current.focus();
        } else {
          headingRef.current?.focus();
        }
      }
    });
  }
}

// JSX Header markup:
<div className="min-w-0 flex-1">
  {editingTitle && isDraft ? (
    <form onSubmit={handleTitleSave} className="space-y-2" aria-label="Edit quiz title">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] max-w-lg flex-1">
          <Input
            ref={titleInputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelTitleEdit();
              }
            }}
            maxLength={TITLE_MAX}
            disabled={savingTitle}
            placeholder="Quiz title…"
            aria-label="Quiz title"
            aria-required="true"
            aria-invalid={Boolean(error && !titleDraft.trim())}
            className="h-11 font-heading text-lg font-semibold pr-16 bg-white/90 dark:bg-card/90"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-bold text-muted-foreground"
          >
            {titleDraft.length}/{TITLE_MAX}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="submit"
            size="sm"
            disabled={savingTitle || !titleDraft.trim()}
            className="h-10 px-3.5 gap-1.5 font-bold"
          >
            {savingTitle ? "Saving…" : <><Check className="size-4" aria-hidden="true" /> Save</>}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelTitleEdit}
            disabled={savingTitle}
            className="h-10 px-3"
          >
            <X className="size-4 mr-1" aria-hidden="true" /> Cancel
          </Button>
        </div>
      </div>
      <p className="text-xs font-semibold text-muted-foreground">
        Press <kbd className="rounded border border-border bg-muted/80 px-1 py-0.5 font-mono text-[10px]">Enter</kbd> to save, <kbd className="rounded border border-border bg-muted/80 px-1 py-0.5 font-mono text-[10px]">Esc</kbd> to cancel.
      </p>
    </form>
  ) : (
    <div className="flex items-center gap-2.5 flex-wrap">
      <h1 ref={headingRef} tabIndex={-1} className="font-heading text-3xl font-semibold outline-none [text-wrap:balance]">
        {quiz.title}
      </h1>
      {isDraft && (
        <div className="flex items-center gap-1">
          <Button
            ref={editTitleBtnRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={startTitleEdit}
            disabled={savingTitle || publishing || settingsOpen}
            aria-label={`Rename quiz: ${quiz.title}`}
            title="Rename title (inline)"
            className="relative size-9 rounded-xl text-muted-foreground hover:text-primary hover:bg-white/60 dark:hover:bg-card/60 transition-colors before:absolute before:-inset-1 before:content-['']"
          >
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
          <Button
            ref={settingsBtnRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              cancelTitleEdit();
              setSettingsOpen(true);
            }}
            disabled={savingTitle || publishing}
            aria-label="Edit quiz settings"
            title="Edit title, mode, and time limit"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            className="relative size-9 rounded-xl text-muted-foreground hover:text-primary hover:bg-white/60 dark:hover:bg-card/60 transition-colors before:absolute before:-inset-1 before:content-['']"
          >
            <Settings2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )}

  <div className="mt-3 flex flex-wrap items-center gap-2.5">
    <span className={`rounded-full border-[3px] px-3 py-1 text-xs font-extrabold select-none cursor-default ${STATUS_CLASS[quiz.status]}`}>
      {STATUS_LABEL[quiz.status]}
    </span>

    {isDraft ? (
      <button
        type="button"
        onClick={() => {
          cancelTitleEdit();
          setSettingsOpen(true);
        }}
        disabled={savingTitle || publishing}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        aria-label={`Quiz mode: ${MODE_LABEL[quiz.mode]}. Click to edit settings.`}
        className={`inline-flex items-center gap-1.5 rounded-full border-[3px] px-3.5 py-1 text-xs font-extrabold cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 ${MODE_CLASS[quiz.mode]}`}
      >
        <span>{MODE_LABEL[quiz.mode]}</span>
        <Pencil className="size-3 opacity-60" aria-hidden="true" />
      </button>
    ) : (
      <span className={`rounded-full border-[3px] px-3 py-1 text-xs font-extrabold select-none cursor-default ${MODE_CLASS[quiz.mode]}`}>
        {MODE_LABEL[quiz.mode]}
      </span>
    )}

    {quiz.mode === "assessment" && quiz.time_limit_sec != null && (
      isDraft ? (
        <button
          type="button"
          onClick={() => {
            cancelTitleEdit();
            setSettingsOpen(true);
          }}
          disabled={savingTitle || publishing}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-label={`Time limit: ${formatDuration(quiz.time_limit_sec)}. Click to edit settings.`}
          className="inline-flex items-center gap-1.5 rounded-full border-[3px] border-border bg-muted px-3.5 py-1 text-xs font-extrabold tabular-nums text-muted-foreground cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60"
        >
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{formatDuration(quiz.time_limit_sec)} limit</span>
          <Pencil className="size-3 opacity-60" aria-hidden="true" />
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border-[3px] border-border bg-muted px-3 py-1 text-xs font-extrabold tabular-nums text-muted-foreground select-none cursor-default">
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          {formatDuration(quiz.time_limit_sec)} limit
        </span>
      )
    )}

    <span className="rounded-full border-[3px] border-border bg-muted px-3 py-1 text-xs font-extrabold text-muted-foreground select-none cursor-default">
      {questions.length} {questions.length === 1 ? "question" : "questions"}
    </span>
  </div>
</div>

{/* Dialog mounting */}
<EditQuizDialog
  open={settingsOpen}
  onOpenChange={handleDialogClose}
  quiz={quiz}
  onSuccess={() => {
    setNotice("Quiz settings updated.");
    router.refresh();
  }}
  onError={(status, message) => {
    setError(message);
    if (status === 409) {
      router.refresh();
    } else if (status === 404) {
      router.push(`/lecturer/classes/${quiz.class_id}`);
    }
  }}
/>
```

---

## 7. Edge Cases & Defensive Matrix

| # | Category | Scenario | Expected Behavior | Defensive Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **E1** | Title | Empty string or whitespace | Block save | Client `disabled={!title.trim()}`; Zod `.trim().min(1)` $\rightarrow$ 400; DB `CHECK` |
| **E2** | Title | Title $> 200$ characters | Block input past 200 chars | Client `maxLength={200}`; Zod `.max(200)` $\rightarrow$ 400; DB `CHECK` |
| **E3** | Time | Time limit $> 7,200\text{s}$ | Block input past 2h | Hours input capped to 2; minutes disabled at 2h; Zod `.max(7200)` $\rightarrow$ 400; DB `CHECK` |
| **E4** | Time | Fractional/Float seconds | Block non-integers | Zod `.int()`; Client keyboard blocks `.` |
| **E5** | Mode | `assessment` $\rightarrow$ `practice` | Stored `time_limit_sec` wiped | `buildQuizUpdates` forces `null`; DB CHECK `quizzes_practice_untimed` |
| **E6** | Mode | `practice` $\rightarrow$ `assessment` | Retains stashed time or untimed | `lastAssessmentHm` stash or lossless `hmToSeconds` |
| **E7** | Mode | Assessment with `null` time | Untimed assessment (allowed) | Zod allows nullable; DB allows null |
| **E8** | Mode | Omitted mode + time on practice | Wiped to `null` | `buildQuizUpdates` checks `currentMode === "practice"` |
| **E9** | Concurrency | Double click Save button | Single request sent | `submitLock.current = true` synchronously locks |
| **E10**| Concurrency | Published in another tab (TOCTOU)| Clean 409 Conflict | Route catches `quiz_not_draft_edit` $\rightarrow$ `notDraft()` (409) $\rightarrow$ client refreshes |
| **E11**| Concurrency | Deleted in another tab | Clean 404 Not Found | `.maybeSingle()` returns null $\rightarrow$ 404 $\rightarrow$ client redirects to class page |
| **E12**| UI Lifecycle | Unmounted trigger focus loss | No focus drop to body | Fallback focus handler targets `settingsBtnRef` or `headingRef` |
| **E13**| UI Lifecycle | Sub-minute limit in modal | Warning banner; not auto-rounded | `isSubMinuteInitial` banner; omit `timeLimitSec` if untouched |
| **E14**| UI Lifecycle | Mutual exclusion inline vs modal| Clean transition | Opening modal calls `cancelTitleEdit()` |
| **E15**| Security | Cross-site CSRF attempt | 403 Forbidden | `checkSameOrigin(request)` |

---

## 8. Verification & QA Test Suite Plan

### 8.1 Vitest Config Updates (`vitest.config.ts`)
```typescript
// Add "src/lib/quizzes/**" to coverage.include (lines 13-26)
// Add per-file thresholds for:
"src/lib/quizzes/updates.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
"src/lib/quizzes/time-limit.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
"src/lib/quizzes/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 },
```

### 8.2 Unit Tests (`U-M1` .. `U-M18`)
* **`src/lib/quizzes/validation.test.ts`**:
  - `U-M1`: `UpdateQuizSchema` accepts partial `{ title: "New" }` without injecting mode or timeLimitSec.
  - `U-M2`: `UpdateQuizSchema` accepts boundary `{ mode: "assessment", timeLimitSec: 7200 }`.
  - `U-M3`: `UpdateQuizSchema` accepts boundary `{ mode: "assessment", timeLimitSec: 1 }`.
  - `U-M4`: `UpdateQuizSchema` rejects `timeLimitSec: 0`, `-1`, `7201`, `30.5`, `NaN`.
  - `U-M5`: `UpdateQuizSchema` rejects empty title `""`, whitespace `"   "`, `> 200` chars (`201`).
  - `U-M6`: `CreateQuizSchema` rejects `timeLimitSec: 7201` (replaces old 72h test).
* **`src/lib/quizzes/updates.test.ts`**:
  - `U-M7`: `buildQuizUpdates` on `assessment → practice` forces `time_limit_sec: null`.
  - `U-M8`: `buildQuizUpdates` with `mode: "practice"` + `timeLimitSec: 1800` forces `time_limit_sec: null`.
  - `U-M9`: `buildQuizUpdates` with omitted mode + `currentMode: "practice"` + `timeLimitSec: 1800` forces `time_limit_sec: null`.
  - `U-M10`: `buildQuizUpdates` with `mode: "assessment"` + `timeLimitSec: 1800` retains 1800.
  - `U-M11`: `buildQuizUpdates` with `mode: "assessment"` + `timeLimitSec: null` retains null.
  - `U-M12`: `buildQuizUpdates` on title-only patch leaves mode and time_limit_sec untouched.
  - `U-M13`: `buildQuizUpdates` does not mutate input object (pure function invariant).
* **`src/lib/quizzes/time-limit.test.ts`**:
  - `U-M14`: `secondsToHm` conversions: `null → {0,0}`, `60 → {0,1}`, `4500 → {1,15}`, `7200 → {2,0}`.
  - `U-M15`: `secondsToHm` out-of-bounds capping: `9000 → {2,0}` with `console.warn`.
  - `U-M16`: `hmToSeconds` conversions: `{0,1} → 60`, `{1,15} → 4500`, `{2,0} → 7200`, `{0,0} → null`.
  - `U-M17`: `hmToSeconds` lossless boundary: `{2,30} → 9000` (schema validates, helper does not truncate).
  - `U-M18`: `secondsToHm(60)` `{0,1}` vs `formatDuration(60)` `"1m"` parity check.

### 8.3 Route Integration Tests (`I-M1` .. `I-M12`)
* **`src/app/api/quizzes/__tests__/quizzes-routes.test.ts`**:
  - `I-M1`: PATCH title only on draft assessment preserves mode and existing `time_limit_sec`.
  - `I-M2`: PATCH `mode: "practice"` on timed draft assessment wipes `time_limit_sec` to `null`.
  - `I-M3`: PATCH `{ mode: "practice", timeLimitSec: 600 }` returns 200 and stores `time_limit_sec: null`.
  - `I-M4`: PATCH `{ mode: "assessment", timeLimitSec: 7200 }` returns 200 and stores 7200.
  - `I-M5`: PATCH `{ mode: "assessment", timeLimitSec: null }` returns 200 and stores null.
  - `I-M6`: PATCH `{ timeLimitSec: 7201 }` $\rightarrow$ 400 `invalid_body`.
  - `I-M7`: PATCH `{ timeLimitSec: 30.5 }` $\rightarrow$ 400 `invalid_body`.
  - `I-M8`: PATCH error mapping: trigger error `quiz_not_draft_edit` on UPDATE $\rightarrow$ 409 `quiz_not_draft`.
  - `I-M9`: PATCH error mapping: DB CHECK error `quizzes_practice_untimed` $\rightarrow$ 400 `invalid_body`.
  - `I-M10`: PATCH error mapping: generic DB connection error $\rightarrow$ 503 `internal`.
  - `I-M11`: POST `/api/classes/[id]/quizzes` with `mode: "practice"` + `timeLimitSec: 600` stores `time_limit_sec: null`.
  - `I-M12`: POST `/api/classes/[id]/quizzes` with `timeLimitSec: 7201` $\rightarrow$ 400 `invalid_body`.

### 8.4 Direct SQL Database Verification (`D26` .. `D28` & `MED-4b`)
* **`scripts/verify-quizzes.mjs`**:
  - `D26`: Direct SQL `INSERT` quiz with `mode = 'practice'` and `time_limit_sec = 600` violates `quizzes_practice_untimed` CHECK.
  - `D27`: Direct SQL `UPDATE` draft quiz setting `mode = 'practice'` and `time_limit_sec = 600` violates CHECK.
  - `D28`: Direct SQL `INSERT` quiz with `time_limit_sec = 0` or `7201` violates `quizzes_time_limit_sec_check`.
  - `MED-4b`: Direct SQL `UPDATE` on a `live` and `closed` quiz attempting to mutate `mode` or `time_limit_sec` raises trigger exception `quiz_not_draft_edit`.

### 8.5 Playwright E2E Test Suite (`E15-1` .. `E15-10` & `e10` Fix)
* **`e2e/e15-quiz-metadata-edit.spec.ts`**:
  - `E15-1`: Inline title edit (<kbd>Enter</kbd> saves, <kbd>Esc</kbd> cancels).
  - `E15-2`: Open `EditQuizDialog` from settings button; assert pre-filled title, mode, hours, minutes.
  - `E15-3`: Change title + time limit to 1h 15m; assert pill renders `1h 15m limit` after refresh.
  - `E15-4`: Toggle mode `assessment → practice`; assert time inputs disabled with live note.
  - `E15-5`: Save practice mode; intercept `PATCH` response via `page.waitForResponse(...)` to assert `time_limit_sec === null` and timer pill unmounted.
  - `E15-6`: Set hours = 2; assert minutes input is automatically disabled and value cleared to `""`.
  - `E15-7`: Mutual exclusion: opening dialog cancels active inline title editing.
  - `E15-8`: Publish quiz; verify settings button and pencil icon are unmounted on live quiz.
  - `E15-9`: Attempt out-of-band `fetch` PATCH on live quiz; assert 409 `quiz_not_draft`.
  - `E15-10`: Accessibility audit: tab focus-visible ring on pills, `aria-labelledby`, `aria-describedby`, error alerts.
* **`e2e/e10-timer-expiry.spec.ts` Fix**:
  - Update `createTimedAssessment` helper to set sub-minute test limits via direct PATCH rather than the obsolete `getByLabel("Time limit (seconds)")` selector.

---

## 9. Atomic Implementation Roadmap

1. **Step 1: Constants, Validation & Shared Pure Utilities**
   - Update `src/lib/quizzes/validation.ts` (`TIME_LIMIT_MAX_SEC = 7200`).
   - Create `src/lib/quizzes/updates.ts` (`buildQuizUpdates`).
   - Create `src/lib/quizzes/time-limit.ts` (`secondsToHm`, `hmToSeconds`, `HOURS_MAX`, `MINUTES_MAX`).
   - Create `src/lib/quizzes/labels.ts` (`STATUS_LABEL`, `STATUS_CLASS`, `MODE_LABEL`, `MODE_CLASS`).
   - Add unit tests `validation.test.ts`, `updates.test.ts`, `time-limit.test.ts`.
   - Update `vitest.config.ts` coverage config.
2. **Step 2: API Routes Hardening**
   - Update `src/app/api/quizzes/[id]/route.ts` with `buildQuizUpdates`, `.maybeSingle()`, and error mapping.
   - Update `src/app/api/classes/[id]/quizzes/route.ts` with practice time-limit sanitization.
   - Add integration tests `quizzes-routes.test.ts` (`I-M1..I-M12`).
3. **Step 3: Database Migration**
   - Create and apply `supabase/migrations/0014_quiz_practice_untimed.sql`.
   - Extend `scripts/verify-quizzes.mjs` with `D26..D28` and `MED-4b`.
4. **Step 4: Create Form Fix**
   - Update `class-detail-client.tsx` to consume `HOURS_MAX`, `MINUTES_MAX`, and `hmToSeconds`.
5. **Step 5: Frontend Dialog & Hero Section**
   - Implement `src/components/quiz/edit-quiz-dialog.tsx`.
   - Update `src/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client.tsx`.
6. **Step 6: E2E Verification & Regression**
   - Create `e2e/e15-quiz-metadata-edit.spec.ts`.
   - Fix `e2e/e10-timer-expiry.spec.ts` and extend `e2e/helpers.ts`.
   - Run `npx tsc --noEmit`, `npm test`, `npm run test:e2e`.

---

## 10. Appendix: Traceability & File Index

| Component / Layer | Primary File | Secondary / Test References |
| :--- | :--- | :--- |
| **Validation Schema** | `src/lib/quizzes/validation.ts` | `src/lib/quizzes/validation.test.ts` |
| **Update Delta Logic** | `src/lib/quizzes/updates.ts` | `src/lib/quizzes/updates.test.ts` |
| **Time Conversions** | `src/lib/quizzes/time-limit.ts` | `src/lib/quizzes/time-limit.test.ts`, `src/lib/format/duration.ts` |
| **Labels & Tokens** | `src/lib/quizzes/labels.ts` | `src/app/globals.css`, `design-system/innovision/MASTER.md` |
| **Quiz API Route** | `src/app/api/quizzes/[id]/route.ts` | `src/app/api/quizzes/__tests__/quizzes-routes.test.ts` |
| **Class Quizzes API** | `src/app/api/classes/[id]/quizzes/route.ts` | `src/app/api/quizzes/__tests__/quizzes-routes.test.ts` |
| **Database Migrations** | `supabase/migrations/0014_quiz_practice_untimed.sql` | `0004_quizzes.sql`, `0007_ai_generation.sql`, `verify-quizzes.mjs` |
| **Settings Dialog** | `src/components/quiz/edit-quiz-dialog.tsx` | `src/components/ui/dialog.tsx`, `select.tsx`, `input.tsx` |
| **Quiz Builder Client**| `src/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client.tsx` | `e2e/e15-quiz-metadata-edit.spec.ts` |
| **Class Detail Client** | `src/app/(lecturer)/lecturer/classes/[id]/class-detail-client.tsx` | `src/lib/quizzes/time-limit.ts` |
| **Coverage Config** | `vitest.config.ts` | All Vitest suites |
