"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ClipboardList, Info, Play, ShieldAlert } from "lucide-react";
import {
  StudentPracticePlayer,
  type SafeQuestion,
} from "@/components/student-quiz/player-client";

export type SharedQuizMeta = {
  title: string;
  description: string | null;
  creator_first_name: string;
  question_count: number;
};

/**
 * /s/[code] landing + play. Landing shows the community-content banner and
 * metadata; Start swaps into the same stateless player used by self-play.
 */
export function SharedQuizClient({
  code,
  quiz,
  questions,
}: {
  code: string;
  quiz: SharedQuizMeta;
  questions: SafeQuestion[];
}) {
  const t = useTranslations("sqPlayer");
  const tMy = useTranslations("myQuizzes");
  const [started, setStarted] = useState(false);

  if (started) {
    return (
      <StudentPracticePlayer
        quizKey={code}
        title={quiz.title}
        questions={questions}
        backHref={`/s/${code}`}
        backLabelKey="back"
      />
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="mb-4 flex items-start gap-3 rounded-[22px] border-[3px] border-amber-300 bg-amber-50 px-5 py-4 shadow-[0_4px_0_rgba(217,119,6,0.15)]">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden />
        <p className="text-sm font-semibold text-amber-800">{t("banner")}</p>
      </div>

      <Card className="rounded-[28px] border-[3px] shadow-[var(--shadow-clay)]">
        <CardHeader>
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-100 text-emerald-600">
            <ClipboardList className="h-7 w-7" aria-hidden />
          </span>
          <CardTitle className="text-2xl [text-wrap:balance]">{quiz.title}</CardTitle>
          <CardDescription>
            {t("byCreator", {
              name:
                quiz.creator_first_name && quiz.creator_first_name.length > 0
                  ? quiz.creator_first_name
                  : t("anonymous"),
            })}
            {" · "}
            {tMy("questionCount", { count: quiz.question_count })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {quiz.description && (
            <p className="flex items-start gap-2 text-sm font-semibold text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {quiz.description}
            </p>
          )}
          {questions.length === 0 ? (
            <p className="text-sm font-bold text-muted-foreground" role="status">
              {t("noQuestions")}
            </p>
          ) : (
            <Button size="lg" className="w-full" onClick={() => setStarted(true)}>
              <Play className="h-5 w-5" aria-hidden /> {t("startBtn")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
