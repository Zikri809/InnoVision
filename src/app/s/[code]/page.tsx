import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeShareCode } from "@/lib/student-quizzes/share-code";
import {
  SharedQuizClient,
  type SharedQuizMeta,
} from "./shared-quiz-client";

async function UnavailableLink() {
  const t = await getTranslations("sqPlayer");
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <p className="font-heading text-xl font-semibold [text-wrap:balance]">
          {t("invalidLink")}
        </p>
        <Link
          href="/dashboard"
          className="rounded-2xl border-[3px] border-border bg-card px-5 py-2.5 text-sm font-extrabold shadow-[0_4px_0_var(--border)]"
        >
          {t("homeCta")}
        </Link>
      </div>
    </div>
  );
}

type Params = { params: Promise<{ code: string }> };

/**
 * /s/[code] — the shared-quiz entry point. Logged-out recipients are bounced
 * through the login wall WITH a return path (`/login?redirect=/s/<code>` —
 * the login page already honors a sanitized redirect param), so the viral
 * link survives authentication.
 *
 * No-oracle rule: invalid format, unknown code, and revoked code all render
 * the SAME neutral "link unavailable" screen.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { code } = await params;
  const normalized = normalizeShareCode(code);
  if (!normalized) return { title: "InnoVision" };
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("resolve_shared_student_quiz", {
      p_code: normalized,
    });
    if (data) {
      const meta = data as { title?: string; creator_first_name?: string };
      return {
        title: meta.title ? `${meta.title} — InnoVision` : "InnoVision",
        description: meta.creator_first_name
          ? `Practice quiz by ${meta.creator_first_name}`
          : "Practice quiz on InnoVision",
      };
    }
  } catch {
    // Metadata is best-effort; the page itself renders the authoritative state.
  }
  return { title: "InnoVision" };
}

export default async function SharedQuizPage({ params }: Params) {
  const supabase = await createClient();
  const { code } = await params;

  const normalized = normalizeShareCode(code);
  if (!normalized) return <UnavailableLink />;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=/s/${encodeURIComponent(normalized)}`);

  const { data: quizMeta } = await supabase.rpc("resolve_shared_student_quiz", {
    p_code: normalized,
  });

  // NULL covers unknown AND revoked — one neutral screen for both.
  if (!quizMeta) return <UnavailableLink />;

  const meta = quizMeta as unknown as SharedQuizMeta & { id: string };

  // Questions ONLY via the player view (no correct_index / explanation).
  const { data: questions } = await supabase
    .from("student_quiz_player_question_view")
    .select("id, quiz_id, order_index, type, prompt, options, created_at")
    .eq("quiz_id", meta.id)
    .order("order_index")
    .order("created_at");

  return (
    <div className="min-h-dvh bg-background">
      <SharedQuizClient
        code={normalized}
        quiz={meta}
        questions={(questions ?? [])
          .filter((q) => q.id && q.type && q.prompt && q.options)
          .map((q) => ({
            id: q.id!,
            order_index: q.order_index ?? 0,
            type: q.type!,
            prompt: q.prompt!,
            options: q.options!,
          }))}
      />
    </div>
  );
}
