"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { BOT_STATES, type BotState } from "@/lib/bot/engine";
import { FaceGate } from "@/components/face/face-gate";
import { FaceVerifier } from "@/components/face/face-verifier";
import { EndScreen } from "@/components/quiz/end-screen";
import { OcrProgress } from "@/components/extract/OcrProgress";

const noop = () => {};

const demoSessionBase = {
  id: "00000000-0000-4000-8000-00000000000a",
  quiz_id: "00000000-0000-4000-8000-00000000000b",
  student_id: "00000000-0000-4000-8000-00000000000c",
  status: "completed" as const,
  started_at: "2026-08-20T09:00:00Z",
  submitted_at: "2026-08-20T09:22:00Z",
  last_activity_at: "2026-08-20T09:22:00Z",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-heading text-lg font-bold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Frame({
  label,
  children,
  trap = false,
}: {
  label: string;
  children: React.ReactNode;
  trap?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-[24px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)] ${
        trap ? "[transform:translateZ(0)]" : ""
      }`}
    >
      <p className="border-b-[3px] border-border/50 bg-muted/60 px-4 py-2 text-left font-heading text-xs font-extrabold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      {children}
    </div>
  );
}

function FakeQuizBehind() {
  return (
    <div className="space-y-3 p-6 opacity-70 select-none" aria-hidden>
      <div className="h-4 w-3/4 rounded-full bg-muted" />
      <div className="grid gap-2">
        {["A", "B", "C", "D"].map((o) => (
          <div key={o} className="flex items-center gap-3 rounded-2xl border-[3px] border-border px-4 py-2.5">
            <span className="grid size-7 place-items-center rounded-full bg-muted font-heading text-xs font-extrabold">
              {o}
            </span>
            <div className="h-3 flex-1 rounded-full bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DevBotPage() {
  // Component playground — not part of the product surface. 404 outside dev
  // so the demo gallery never ships as a reachable production route.
  if (process.env.NODE_ENV !== "development") notFound();

  const [cycle, setCycle] = useState<BotState>(BOT_STATES[0]);

  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % BOT_STATES.length;
      setCycle(BOT_STATES[i]);
    }, 1700);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-heading text-2xl font-semibold">BotAvatar</h1>
      <p className="mt-1 text-sm font-semibold text-muted-foreground">
        Dev preview — every state, live morph cycle, and the real components using them.
      </p>

      <Section title="States">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {BOT_STATES.map((s) => (
            <div
              key={s}
              className="rounded-[20px] border-[3px] border-border bg-card p-5 text-center shadow-[var(--shadow-clay-sm)]"
            >
              <div className="grid place-items-center">
                <BotAvatar state={s} size={88} />
              </div>
              <p className="mt-3 font-heading text-sm font-bold">{s}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Morph cycle">
        <div className="rounded-[20px] border-[3px] border-border bg-card p-6 text-center shadow-[var(--shadow-clay-sm)]">
          <div className="grid place-items-center">
            <BotAvatar state={cycle} size={120} />
          </div>
          <p className="mt-3 font-heading text-sm font-bold">cycling → now: {cycle}</p>
        </div>
      </Section>

      <Section title="In context — face gate">
        <div className="grid gap-5 md:grid-cols-2">
          <Frame label="FaceGate — liveness waiting (scanning)">
            <FaceGate
              consentGiven
              enrolled
              remainingMs={45200}
              livenessState="waiting"
              status="gate"
              onBegin={noop}
              onConsent={noop}
            />
          </Frame>
          <Frame label="FaceGate — liveness failed (fail)">
            <FaceGate
              consentGiven
              enrolled
              remainingMs={null}
              livenessState="failed"
              status="gate"
              onBegin={noop}
              onConsent={noop}
            />
          </Frame>
        </div>
      </Section>

      <Section title="In context — end screen">
        <div className="grid gap-5 md:grid-cols-2">
          <Frame label="EndScreen — practice (celebrate)">
            <EndScreen
              session={{ ...demoSessionBase, mode: "practice", score: 7 }}
              quiz={{
                id: demoSessionBase.quiz_id,
                title: "Chapter 1: Motion",
                mode: "practice",
                status: "closed",
                time_limit_sec: null,
              }}
              revealed={false}
              score={7}
              total={10}
              breakdown={[]}
            />
          </Frame>
          <Frame label="EndScreen — assessment revealed (success)">
            <EndScreen
              session={{ ...demoSessionBase, mode: "assessment", score: 9 }}
              quiz={{
                id: demoSessionBase.quiz_id,
                title: "Final Comprehensive Exam",
                mode: "assessment",
                status: "closed",
                time_limit_sec: 4500,
                results_revealed_at: "2026-08-21T00:00:00Z",
              }}
              revealed
              score={9}
              total={10}
              breakdown={[]}
            />
          </Frame>
        </div>
      </Section>

      <Section title="In context — session overlays">
        <div className="grid gap-5 md:grid-cols-2">
          <Frame label="FaceVerifier — paused overlay (paused)" trap>
            <FaceVerifier
              status="paused"
              phase="question"
              enrolled
              consentGiven
              remainingMs={null}
              pausedReason="focus_lost"
              onBegin={noop}
              onConsent={noop}
              onRecover={noop}
              onCheckAgain={noop}
            >
              <FakeQuizBehind />
            </FaceVerifier>
          </Frame>
          <Frame label="FaceVerifier — flagged overlay (warn)" trap>
            <FaceVerifier
              status="flagged"
              phase="timeUp"
              enrolled
              consentGiven
              remainingMs={null}
              pausedReason="face"
              onBegin={noop}
              onConsent={noop}
              onRecover={noop}
              onCheckAgain={noop}
            >
              <FakeQuizBehind />
            </FaceVerifier>
          </Frame>
        </div>
      </Section>

      <Section title="In context — extraction & generation">
        <div className="grid gap-5 md:grid-cols-2">
          <Frame label="OcrProgress — extracting (thinking)">
            <div className="p-5">
              <OcrProgress page={3} total={12} label="Extracting text…" />
            </div>
          </Frame>
          <Frame label="GenerateFromFileDialog — busy banner (thinking)">
            <div className="p-5">
              <div className="flex items-center justify-center gap-2.5 rounded-2xl border-[3px] border-primary/30 bg-primary/5 px-4 py-3">
                <BotAvatar state="thinking" size={32} />
                <span className="text-sm font-extrabold text-primary">
                  Generating questions…
                </span>
              </div>
            </div>
          </Frame>
        </div>
      </Section>
    </main>
  );
}
