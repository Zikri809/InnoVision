# InnoVision — Exhibition Day Manual

> **Purpose:** a plain-language manual for the developer presenting this system
> who needs to (re)understand what it does, how it fits together, how to start
> it, what to click during a demo, and how to recover when something breaks.
>
> Deep detail lives in `docs/ARCHITECTURE.md` (how everything works) and
> `docs/README.md` (which doc is authoritative). This file is the fast,
> exhibition-oriented layer on top.

---

## 1. What InnoVision is (the 30-second answer)

**InnoVision is a proctored classroom quiz platform.**

- **Lecturers** create classes with join codes, author quizzes (by hand, or by
  AI from uploaded lecture files — even a topic searched off the web), publish
  them live, monitor attempts live, and review results + integrity footage.
- **Students** join a class (by code or by scanning a QR), enroll their face
  once, then take assessments where a webcam continuously verifies *they* are
  the one answering. They answer by clicking **or by holding up fingers to the
  camera** (hand tracking).
- **Students** can also create their own private practice quizzes and share
  them with friends via a link code.

The one sentence that explains 80% of the architecture — and a great answer to
any "how do you stop cheating?" question:

> **The browser is never trusted.** Every important verdict — face match,
> score, timer, pass/fail, state transitions — is computed or re-validated on
> the server, mostly inside Postgres database functions. Even the correct
> answers are never sent to the student's browser until results are revealed.

---

## 2. The big picture: what runs where

```
Browser (students + lecturer)
  Next.js app: pages, quiz player, camera pipelines
  MediaPipe (in-browser AI): face landmarks + blink, hand tracking
        │
        ▼
Next.js server (Node) — ~51 API routes, all self-authenticating
        │
        ▼
Supabase  = Postgres database (with row-level security on everything)
        + Auth (login, sessions, Microsoft SSO)
        + Storage (private buckets: quiz files, incident footage, avatars)
        + Realtime (notification bell updates)
        │
        ├── InsightFace sidecar (Docker) — the face-recognition engine
        │     loopback-only at 127.0.0.1:8000; compares webcam frames
        │     against the student's enrolled face samples
        │
        └── GLM-OCR (optional, Docker GPU or Z.ai cloud API)
              reads scanned/image PDFs so AI can generate quizzes from them
```

Mental model in one line each:

| Piece | What it is | Do I need it for a demo? |
|---|---|---|
| Next.js app | The website itself (`npm run dev`, port 3000) | **Always** |
| Supabase | Database + logins + file storage (`npx supabase start`) | **Always** (local) or hosted |
| InsightFace sidecar | Face recognition container (`npm run face:start`) | **Yes** if demoing face verify |
| GLM-OCR | OCR for scanned PDFs (`npm run glm:start`, GPU) | Only if demoing OCR on scanned docs |
| AI endpoint | Quiz generation + short-text marking (`AI_*` env) | Yes if demoing AI quiz generation |

**Two deployment postures** — know which one you're presenting on:

1. **Laptop stack (everything local):** `npx supabase start` + Docker
   containers + `npm run dev`. Most reliable for exhibition (no venue Wi-Fi
   dependency for the backend).
2. **VPS (deployed):** hosted at the site domain (nginx → app container →
   hosted Supabase + Z.ai OCR). Runbook: `docs/DEPLOY_VPS.md`. Depends on
   venue internet — have the laptop stack as fallback.

---

## 3. The two user journeys (what you'll actually click)

### Lecturer journey

1. **Register** with a lecturer invite code (`LECTURER_INVITE_CODE` env; the
   code is compared in constant time and grants the lecturer role — normal
   signups are always students).
2. **Create a class** → get a 6-character join code (e.g. `DEMK42`) and a
   **QR code** students scan to join + auto-login flow.
3. **Author a quiz** in the builder:
   - Manually add questions (MCQ / true-false / multi-select / short-text).
   - **AI-generate**: upload a PDF/DOCX/PPTX → text extracted (or OCR'd if
     scanned) → AI writes questions → saved atomically. Can also generate
     from a *topic* using grounded web search, with real source citations.
4. **Publish** (`draft → live`). Students get a notification. Only a live
   quiz is visible/startable by students; publishing an empty quiz is blocked.
5. **Monitor**: results dashboard shows sessions, face-check timeline,
   advisories, incident clips (short pre-incident videos), audit timeline.
   Lecturer controls per session: **Unlock** (recover a flagged/paused
   student), **Exempt face** (camera-off fallback), **Reset** (void attempt).
6. **Close** the quiz (`live → closed`, one-way). **Reveal results** — scores
   stay secret from students until this flip (or enable auto-reveal).
7. **Review**: gradebook matrix (student × quiz), per-question insight bars
   (% correct, distractor picks), Excel export, per-session breakdowns.

### Student journey

1. **Join a class** by code or QR scan (wrong code 5 times → 15-minute lock).
2. **Enroll face once**: consent checkbox FIRST (camera never starts before
   consent), then 3 angles (front/left/right) with a **blink liveness check**
   each, server-side pose validation. Result: `enrolled` (or `pending_review`
   if the server suspects a duplicate identity — lecturer approves manually).
3. **Start an assessment** (requires consent + enrollment; camera-off
   students can still complete click-first — lecturer can exempt face).
   Then the play loop:
   - **Fullscreen lockdown** while armed; leaving fullscreen pauses.
   - Questions answered by click **or gestures**: hold up N fingers to select
     option N (calibrated with an open palm), open palm commits. Losing both
     hands mid-hold pauses briefly and auto-resumes.
   - **Face verify every ~30–45 s** and at question transitions: frames go to
     the server, compared 1:1 against YOUR enrolled samples (never a gallery
     search). 3 fails in the last 5 checks → session **pauses** → recovery =
     blink challenge + re-verify.
   - **Tab-switch / focus loss** is tracked: 3rd strike auto-flags the
     session. A **flagged** session can only be recovered by the lecturer.
   - If the server detects a **second face** in the frames → review-only
     advisory chip on the lecturer dashboard.
   - If anything suspicious triggers a pause/flag, a short **pre-incident
     video clip** (ring buffer of the last seconds) uploads automatically.
     Clean sessions upload nothing.
4. **Submit** → score computed server-side. Student sees *nothing* about
   correctness until the lecturer reveals results (even the answer feedback
   is withheld pre-reveal — the wire is keyless).
5. **After reveal**: score + per-question review. Lecturer dashboard gets the
   full matrix regardless.
6. **Practice quizzes** (no proctoring): students author their own, share via
   10-char link code, play instantly with immediate feedback. Zero writes
   server-side during play — the author can't see who played.

---

## 4. The impressive bits (what makes this project stand out)

Keep these ready as talking points:

1. **Face verification with anti-replay** — every verify carries a
   server-rotated nonce (`verify_nonce`); replaying an old request fails.
   Verdict is a strict majority vote across up to 3 frames; frames are hashed
   and **pixels are never stored** — only hashes and similarity numbers.
2. **Gesture answering** — MediaPipe hand tracking in the browser; hold N
   fingers, open palm to commit. Works for multi-select too (toggle set, palm
   commits). Skippable → click fallback.
3. **Server-authoritative everything** — answers are graded in Postgres; the
   correct answer literally never reaches the browser pre-reveal; scores are
   column-revoked from direct client reads and only exposed through
   reveal-gated views.
4. **Integrity evidence trail** — every pause/flag/unlock/exempt writes an
   audit event; incident clips give the lecturer the seconds *before* an
   event; advisories (looked away, voice activity, second face) surface as
   chips.
5. **AI quiz generation with provenance** — from uploaded files (with real
   extraction/OCR pipeline) or from a web topic with citations that were
   actually fetched (fabricated URLs impossible by construction); streams
   progress live (thinking accordion, per-stage strip).
6. **AI marking of short-text answers** (v4.9) — worker sweeps pending
   answers and marks them.
7. **QR join flow** — lecturer shows QR, student scans, lands pre-authed into
   the join-confirm; the `?redirect=` handoff survives all three auth paths
   (password, registration email-confirm, Microsoft SSO).

---

## 5. Demo accounts and seeded data

The seed script creates a believable semester (`scripts/seed-demo.mjs`):

```bash
npm run seed:demo          # local;  --remote targets the hosted project
```

**Password for ALL seeded accounts: `Password123!`**

| Account | Role | Notes |
|---|---|---|
| `lecturer@innovision.test` | Lecturer (Dr. Farah Omar) | Owns the demo classes |
| `lecturer2@innovision.test` | Lecturer (Dr. Rajesh Kumar) | Second lecturer |
| `student1@…` … `student10@innovision.test` | Students | Varied engagement; e.g. `student1` = Muhammad Danish |

Seeded classes (join codes):

| Class | Code | State |
|---|---|---|
| CS101 — Intro to Algorithms | `DEMK42` | active |
| CS205 — Database Systems | `DBSYS5` | active |
| CS100 — Programming Fundamentals | `ARCH99` | **archived** (shows join rejection) |

Seeded quizzes: a live **"Assessment: Midterm — Algorithms"**, a closed
**"Weekly Quiz 3 — Sorting"** with historical sessions and *revealed*
results (best for showing the gradebook/insights without touching anything),
drafts, and student practice quizzes (some shared).

**Face enrollment is intentionally NOT seeded** — biometric enrollment is a
deliberate user action. If you want to demo face verify live, enroll the demo
student's face beforehand (or during, as part of the show).

Fresh slate any time:

```bash
npx supabase db reset && npm run seed:demo
```

---

## 6. Starting the laptop stack (the runbook)

Prereqs: **Docker Desktop running**, `.env.local` populated (see
`.env.local.example`).

```bash
# 1. Database + auth + storage (Supabase local)
npx supabase start

# 2. Face-recognition sidecar (needs Docker; takes ~1-2 min to become healthy)
npm run face:start
docker ps                      # wait for insightface-service = healthy

# 3. The web app (port 3000)
npm run dev

# 4. Demo data (if DB is fresh)
npm run seed:demo

# 5. OPTIONAL: local OCR engine (GPU only; slow on CPU — skip unless demoing OCR)
npm run glm:start
```

Quick health checks before doors open:

| Check | Command / URL | Expected |
|---|---|---|
| App up | `http://localhost:3000/api/health` | JSON ok (checks DB reachability) |
| Face sidecar | `docker ps` status | `healthy` |
| Login works | log in as `lecturer@innovision.test` | dashboard loads |
| Face boot | log in as a student, open face enrollment page | camera starts after consent |
| AI generation | (if demoing) generate from a small PDF in a draft quiz | questions appear |

Also useful:

```bash
npm run test:face-smoke   # end-to-end face pipeline smoke test
npm run check:env         # env parity check
```

### 6b. Optional: demo mode (walk-up kiosk)

If you want visitors to scan a QR and get an auto-created student account
(no signup), enable the flag-gated demo mode
(`docs/plans/PLAN_DEMO_MODE.md`):

```bash
# PowerShell: $env:NEXT_PUBLIC_DEMO_MODE=1; npm run demo:prep
NEXT_PUBLIC_DEMO_MODE=1 npm run demo:prep
```

That one command runs supabase start → db reset → seed:demo → face:start →
demo:reset → `next build` (with the flag) → `next start -H 0.0.0.0`. Then:

- Visitors scan `http://<this-machine-LAN-IP>:3000/join/SCAN23` → tap **Join
  the demo** → they play the walk-up practice quiz instantly (no camera).
- The presenter control room is `http://localhost:3000/demo` (demo-lecturer
  only): pre-flight ticks + a **Reset walk-up** button.
- Run `npm run demo:reset:walkup` (or the /demo button) **between shows**;
  it deletes guests older than 2h and recreates the quiz.
- **Never** set `NEXT_PUBLIC_DEMO_MODE=1` in a real deployment — it is a kill
  switch (`prod-guards.ts`); CI/Docker refuse a prod build carrying it.

---

## 7. Exhibition-day demo script (a proven order)

**Golden rules:**
- **Use an UNTIMED quiz for the live demo.** A timed quiz counts time spent in
  the face gate — it can auto-submit a score of 0 if time expires during
  enrollment/blink. (This is pinned behaviour, not a bug.)
- **Enroll the demo student's face before the audience arrives** — lighting
  and rehearsals matter for face verify.
- Two devices beat one: laptop for the lecturer, phone/tablet for the student
  (scanning the QR on the projector is a great moment).
- Have the closed "Weekly Quiz 3" seeded so the gradebook/results story works
  even if live networking misbehaves.

**Suggested 8–10 minute flow:**

1. **(Lecturer, laptop)** Show the class with its **QR code** on screen.
2. **(Student, phone)** Scan QR → confirm join → in the class. Point out the
   join-code lockout and archived-class rejection on the seeded archived
   class if asked.
3. **(Student)** Face enrollment: consent → blink → 3 angles → enrolled.
   Mention: consent before camera, blink = liveness, pixels never stored.
4. **(Lecturer)** Open the live Midterm assessment. **(Student)** Start it:
   fullscreen arms, face gate, then answer one question **by holding up
   fingers** (gestures), one by click. Deliberately switch tabs once → focus
   advisory. Let face verify run (30–45 s cadence).
5. **(Student)** Submit. Show that the student sees **"awaiting results"** —
   no score, no correct answers.
6. **(Lecturer)** Results dashboard: session appears, advisories/face-check
   timeline, incident clip if one triggered. Toggle **reveal**.
7. **(Student)** Refresh → score + per-question breakdown now visible.
8. **(Lecturer)** Gradebook matrix + question insights + (optional) Excel
   export on the closed quiz.
9. **(Either)** AI quiz generation: pick the draft quiz, generate from an
   uploaded PDF — show the live stream (thinking accordion, stages), then the
   questions landing in the builder with source chips.
10. **(Optional closer)** Student practice quiz + share link played on the
    phone.

If time is short: QR join → face enroll → gesture answer → submit → reveal →
gradebook is the core story.

---

## 8. When things break (troubleshooting table)

| Symptom | Likely cause | Fix |
|---|---|---|
| Face verify times out / "unavailable" | InsightFace container down or still loading | `npm run face:start`; wait for `docker ps` → healthy (start period ~90 s) |
| Camera never starts | Browser permissions; page not on localhost/HTTPS | Allow camera; localhost is exempt from the HTTPS requirement |
| Student can't join class | Wrong code / archived class / too many failed attempts | Codes: `DEMK42`, `DBSYS5`; archived = rejected by design; 5 fails → 15-min lock (can clear via DB or wait) |
| Can't publish quiz | No questions | Add ≥1 question (DB trigger `cannot_publish_empty_quiz`) |
| Student sees no score | Results not revealed | Lecturer: Reveal on the quiz (or enable auto-reveal) |
| Session stuck "paused" | Face fail streak / focus strikes | Student: blink-challenge recovery. Flagged = **lecturer-only** unlock (results dashboard) |
| Student has no camera / camera died | — | Lecturer: **Exempt face** on the session; student continues click-first |
| Start refused: `face_enrollment_pending` | Enrollment flagged for duplicate-identity review | Lecturer approves in the classes-dashboard review panel |
| Start refused: `consent_required` | Consent not granted | Student completes consent on the enrollment page |
| Enrollment refused: `live_assessment` | Student has an active assessment session | Finish/exit that session first (deliberate anti-bypass rule) |
| Quiz locked for editing | It's live/closed | Editing is draft-only by design; duplicate the quiz to edit a copy |
| AI generation fails | AI endpoint/env missing, or OCR needed on scanned PDF | Check `AI_*` env; for scanned docs run the OCR path (`glm:start` locally or Z.ai remote) |
| Notification bell empty | Realtime needs Supabase up; polling fallback exists | Check Supabase; there is a visibility-aware polling fallback |
| Everything 404-ish after login | Wrong Supabase env / schema not pushed | `npx supabase start`, then `npx supabase db push` (or `db reset`) |
| VPS: site down | Check container + nginx | `docker compose ps` on the box; app binds loopback :3000, nginx fronts TLS. See `docs/DEPLOY_VPS.md` §13 failure-mode table |

**Nuclear options:** `npx supabase db reset && npm run seed:demo` (wipes local
data, reseeds). On the VPS, rollback is a documented Postgres restore — not a
demo-day move; fall back to the laptop stack instead.

---

## 9. Q&A cheat sheet (questions visitors will actually ask)

**"How do you stop cheating?"**
Layered: continuous 1:1 face verification with nonce-based anti-replay; a
3-of-5 fail window pauses the session; blink liveness to recover; tab-switch
focus tracking that auto-flags on the 3rd strike; fullscreen lockdown;
server-detected second-face advisories; automatic pre-incident video clips;
and the deepest layer — the server never trusts the client, scores are
computed in the database and hidden until reveal.

**"Can a student see the answers before submitting?"**
No. The answer key never crosses the wire pre-reveal — the answer endpoint
responds with a keyless `{ok}`. Correctness flags and scores are
column-revoked at the database level and only re-exposed through
reveal-gated views.

**"What about privacy?"**
Consent is captured before the camera ever starts; webcam frames are hashed
and never stored; incident clips exist only for paused/flagged events, in a
private bucket with signed 1-hour URLs; images/avatars are in zero-policy
private buckets reachable only through the API.

**"What if a student's camera breaks mid-exam?"**
The lecturer can exempt face for that session; the student completes
click-first and the exemption is audited.

**"Where is the AI?"**
Three places: quiz generation from uploaded material or a web topic (with
streaming progress and real citations), OCR for scanned documents (local GPU
or cloud), and AI marking of short-text answers.

**"What happens offline / on flaky Wi-Fi?"**
Notifications degrade to polling; play itself is server-authoritative so it
needs connectivity — one reason the laptop-local stack is the safe exhibition
choice.

**"Is it real-time?"**
Yes for notifications (Supabase Realtime + polling fallback) and lecturer
monitoring refreshes; face verify runs on a 30–45 s cadence by design.

**"How is it built?"**
Next.js 16 (React 19) + TypeScript + Tailwind; Supabase (Postgres with
row-level security on every table, Auth, Storage, Realtime); MediaPipe
in-browser vision; a self-hosted InsightFace Docker sidecar for face
embeddings; Zod-validated API routes; Playwright + Vitest test suites; i18n
in English and Malay.

---

## 10. Glossary (the codebase's vocabulary)

| Term | Meaning |
|---|---|
| **RLS** | Row-Level Security — database rules so users can only read/write their own rows, even with the app's public key |
| **RPC** | Remote Procedure Call — a Postgres function the app calls; all sensitive writes go through these |
| **`verify_nonce`** | A one-time token rotated after every face check; prevents replaying old verification requests |
| **Face fail streak** | 3 failures within the last 5 checks → session pauses |
| **Flagged** | Terminal session state after 3 focus strikes (or integrity triggers); only a lecturer can unlock |
| **Exempt face** | Lecturer-granted camera-off fallback; student completes click-first |
| **Reveal** | The one-way switch (`results_revealed_at`) that lets students see scores/answers |
| **Incident clip** | Short video of the seconds *before* a pause/flag, uploaded automatically from an in-memory ring buffer |
| **Advisory** | Review-only integrity signals (looked away, voice activity, second face) shown to the lecturer |
| **No-oracle** | Error design rule: "not yours" and "doesn't exist" return the same 404 so attackers learn nothing |
| **Keyless ack** | The answer endpoint's pre-reveal response that confirms receipt without saying right/wrong |
| **Practice quiz** | Student-authored, unproctored, shared by link code; zero server writes during play |
| **Gradebook** | Lecturer's student × quiz score matrix across the class |
| **Draft-frozen** | Question rows can't change once a quiz goes live (keeps per-student shuffling and answer keys consistent) |

---

## 11. Where to read more (the authority map)

| Want… | Read |
|---|---|
| How everything works end to end | `docs/ARCHITECTURE.md` — the single best doc in the repo |
| Which docs are current vs historical | `docs/README.md` (index with status banners) |
| Face/integrity pipeline details | `docs/PLAN_INTEGRITY_SUITE.md` |
| Testing: unit, SQL harnesses, E2E | `docs/TESTING.md` |
| VPS deployment + failure modes | `docs/DEPLOY_VPS.md` (+ `docs/DEPLOY_CICD.md` for the git-push pipeline) |
| OCR setup (local vs cloud leg) | `docs/GLM_OCR_SETUP.md` |
| Face sidecar setup | `docs/INSIGHTFACE_SETUP.md` |
| Costs | `docs/COSTS.md` |

> When a doc and the code disagree, the code + `supabase/migrations/` win.
> `docs/HANDOFF.md`, `docs/SECURITY_AUDIT.md` and `docs/PLAN.md` are
> historical snapshots — do not cite them as current.
