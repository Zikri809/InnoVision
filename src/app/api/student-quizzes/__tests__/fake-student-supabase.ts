/**
 * FakeSupabase extension for the student practice-quiz routes.
 *
 * Inherits the fluent builder from the lecturer fake (same module — single
 * source of truth for query semantics) and adds:
 *  - VIEW mapping: student_quiz_player_question_view → student_quiz_questions
 *  - route-mapping RPC stubs: append_student_question /
 *    reorder_student_questions / answer_student_question /
 *    resolve_shared_student_quiz
 *
 * STUBS ONLY, in lockstep with migration 0023; the authoritative SQL-semantics
 * checks are scripts/verify-student-quizzes.mjs. NOT a production module.
 */
import { FakeSupabase } from "@/app/api/quizzes/__tests__/fake-supabase";

type Row = Record<string, unknown> & { id?: string };

function randomUuid(): string {
  return crypto.randomUUID();
}

export class StudentFakeSupabase extends FakeSupabase {
  override from(table: string) {
    if (table === "student_quiz_player_question_view") {
      return super.from("student_quiz_questions");
    }
    return super.from(table);
  }

  override async rpc(name: string, args?: Record<string, unknown>) {
    if (name === "append_student_question") return this._appendStudentQuestion(args);
    if (name === "reorder_student_questions") return this._reorderStudentQuestions(args);
    if (name === "answer_student_question") return this._answerStudentQuestion(args);
    if (name === "resolve_shared_student_quiz") return this._resolveShared(args);
    if (name === "student_quiz_share_action") return this._shareAction(args);
    if (name === "save_student_quiz_questions") return this._saveStudentQuizQuestions(args);
    return super.rpc(name, args);
  }

  seedStudentQuiz(quiz: Row) {
    this.tables["student_quizzes"] ??= [];
    this.tables["student_quizzes"].push({
      description: null,
      share_code: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...quiz,
    });
  }

  seedStudentQuestion(question: Row) {
    this.tables["student_quiz_questions"] ??= [];
    this.tables["student_quiz_questions"].push({
      explanation: null,
      created_at: "2026-01-01T00:00:00Z",
      ...question,
    });
  }

  /**
   * Bulk-save mirror (0029) — STUBS ONLY, lockstep with the migration; the
   * authoritative checks live in scripts/verify-media.mjs. Models: auth null,
   * is_student demotion, ownership, mode whitelist, jsonb shape (array +
   * per-row object + required fields), cap counting under the same error key
   * the route maps, and ATOMIC replace/append (a mid-batch failure inserts
   * nothing).
   */
  private async _saveStudentQuizQuestions(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) {
      return this.rpcResult;
    }
    if (!this.user) return { data: null, error: { message: "not_authenticated" } };
    if (this.profileRole !== "student") {
      return { data: null, error: { message: "not_student" } };
    }
    const quizId = String(args?.p_quiz_id);
    const quiz = (this.tables["student_quizzes"] ?? []).find(
      (q) => q.id === quizId && q.created_by === this.user?.id,
    );
    if (!quiz) return { data: null, error: { message: "not_owner" } };

    const mode = args?.p_mode ?? "replace";
    if (mode !== "replace" && mode !== "append") {
      return { data: null, error: { message: "invalid_mode" } };
    }

    const rows = args?.p_questions;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50) {
      return { data: null, error: { message: "invalid_questions_json" } };
    }
    for (const r of rows) {
      if (
        typeof r !== "object" || r === null ||
        typeof (r as Row).type !== "string" ||
        typeof (r as Row).prompt !== "string" ||
        !Array.isArray((r as Row).options) ||
        typeof (r as Row).correct_index !== "number"
      ) {
        return { data: null, error: { message: "invalid_question_fields" } };
      }
    }

    const questions = (this.tables["student_quiz_questions"] ??= []);
    const mine = questions.filter((q) => q.quiz_id === quizId);
    if (mode === "append" && mine.length + rows.length > 50) {
      return { data: null, error: { message: "question_cap_reached" } };
    }

    // Atomicity: validate everything BEFORE mutating anything.
    const staged: Row[] = [];
    let order = mode === "replace" ? 0 : mine.reduce((m, q) => Math.max(m, (q.order_index as number) ?? -1), -1) + 1;
    for (const r of rows as Row[]) {
      staged.push({
        id: randomUuid(),
        quiz_id: quizId,
        order_index: order++,
        type: r.type,
        prompt: r.prompt,
        options: r.options,
        correct_index: r.correct_index,
        explanation: r.explanation ?? null,
        created_at: "2026-01-01T00:00:00Z",
      });
    }

    if (mode === "replace") {
      this.tables["student_quiz_questions"] = questions.filter((q) => q.quiz_id !== quizId);
    }
    this.tables["student_quiz_questions"].push(...staged);

    // setof semantics: return ONLY the rows inserted by THIS call.
    return { data: staged, error: null };
  }

  /** Mirror of append_question + the 50-question cap trigger's error key. */
  private async _appendStudentQuestion(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) {
      return this.rpcResult;
    }
    const quizId = String(args?.p_quiz_id);
    const quiz = (this.tables["student_quizzes"] ?? []).find(
      (q) => q.id === quizId && q.created_by === this.user?.id,
    );
    if (!quiz) return { data: null, error: { message: "not_owner" } };

    const questions = (this.tables["student_quiz_questions"] ??= []);
    const mine = questions.filter((q) => q.quiz_id === quizId);
    if (mine.length >= 50) {
      return { data: null, error: { message: "question_cap_reached" } };
    }
    const row: Row = {
      id: randomUuid(),
      quiz_id: quizId,
      order_index: mine.reduce((m, q) => Math.max(m, (q.order_index as number) ?? -1), -1) + 1,
      type: args?.p_type,
      prompt: args?.p_prompt,
      options: args?.p_options,
      correct_index: args?.p_correct_index,
      explanation: args?.p_explanation || null,
      created_at: "2026-01-01T00:00:00Z",
    };
    questions.push(row);
    return { data: row, error: null };
  }

  /** Validates the exact id set then renumbers (mirror of 0004 semantics). */
  private async _reorderStudentQuestions(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) {
      return this.rpcResult;
    }
    const quizId = String(args?.p_quiz_id);
    const orderedIds = (args?.p_ordered_ids as string[] | undefined) ?? [];
    const quiz = (this.tables["student_quizzes"] ?? []).find(
      (q) => q.id === quizId && q.created_by === this.user?.id,
    );
    if (!quiz) return { data: null, error: { message: "not_owner" } };

    const questions = (this.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === quizId,
    );
    if (orderedIds.length !== questions.length) {
      return { data: null, error: { message: "id_count_mismatch" } };
    }
    const found = new Set(
      questions.filter((q) => orderedIds.includes(q.id as string)).map((q) => q.id),
    );
    if (found.size !== questions.length) {
      return { data: null, error: { message: "foreign_question_id" } };
    }
    for (const [i, id] of orderedIds.entries()) {
      const row = this.tables["student_quiz_questions"].find((q) => q.id === id);
      if (row) row.order_index = i;
    }
    return { data: null, error: null };
  }

  /**
   * Single-snapshot grading mirror: creator-or-shared gate + bounds check +
   * NULL rejection all fold into ONE unavailable shape.
   */
  private async _answerStudentQuestion(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) {
      return this.rpcResult;
    }
    const questionId = String(args?.p_question_id);
    const selectedIndex = args?.p_selected_index as number | undefined;

    const question = (this.tables["student_quiz_questions"] ?? []).find(
      (q) => q.id === questionId,
    );
    const quiz = question
      ? (this.tables["student_quizzes"] ?? []).find((s) => s.id === question.quiz_id)
      : undefined;

    const allowed =
      !!question &&
      !!quiz &&
      (quiz.created_by === this.user?.id ||
        (quiz.share_code != null && quiz.share_code !== ""));

    if (
      !allowed ||
      selectedIndex == null ||
      selectedIndex < 0 ||
      selectedIndex >= ((question!.options as string[]) ?? []).length
    ) {
      return { data: { error: "unavailable" }, error: null };
    }

    return {
      data: {
        is_correct: selectedIndex === question!.correct_index,
        correct_index: question!.correct_index,
        explanation: question!.explanation ?? null,
      },
      error: null,
    };
  }

  /** Code → metadata + creator FIRST NAME ONLY (created_by never returned). */
  private async _resolveShared(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) {
      return this.rpcResult;
    }
    const code = String(args?.p_code ?? "").trim().toUpperCase();
    const quiz = (this.tables["student_quizzes"] ?? []).find(
      (s) => s.share_code === code,
    );
    if (!quiz) return { data: null, error: null };

    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === quiz.created_by);
    const fullName = String(profile?.full_name ?? "");
    const firstName = fullName.trim().split(/\s+/)[0] ?? "";

    return {
      data: {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        updated_at: quiz.updated_at,
        creator_first_name: firstName,
        question_count: (this.tables["student_quiz_questions"] ?? []).filter(
          (q) => q.quiz_id === quiz.id,
        ).length,
        created_at: quiz.created_at,
      },
      error: null,
    };
  }

  /**
   * The ONLY share_code write path (mirrors 0023's definer RPC): creator +
   * student gated, share idempotent, regenerate requires currently-shared,
   * charset backstop, code_collision on unique-index conflict.
   */
  private async _shareAction(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) {
      return this.rpcResult;
    }
    if (!this.user) return { data: null, error: { message: "not_authenticated" } };
    if (this.profileRole !== "student") {
      return { data: null, error: { message: "not_student" } };
    }
    const quizId = String(args?.p_quiz_id);
    const action = String(args?.p_action ?? "");
    const code = args?.p_code == null ? null : String(args.p_code);

    const quizzes = (this.tables["student_quizzes"] ??= []);
    const quiz = quizzes.find((q) => q.id === quizId && q.created_by === this.user?.id);
    if (!quiz) return { data: null, error: { message: "not_owner" } };

    const current = quiz.share_code as string | null;

    if (action === "unshare") {
      quiz.share_code = null;
      return { data: { share_code: null }, error: null };
    }
    if (action === "share" && current != null) {
      return { data: { share_code: current }, error: null };
    }
    if (action === "regenerate" && current == null) {
      return { data: null, error: { message: "not_shared" } };
    }
    if (!(action === "share" || action === "regenerate") || code == null) {
      return { data: null, error: { message: "invalid_action" } };
    }
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)) {
      return { data: null, error: { message: "invalid_code" } };
    }

    // Collision against ANOTHER quiz's live code mirrors the partial unique
    // index for BOTH mint paths (lockstep with 0023's code_collision mapping).
    if (
      quizzes.some((q) => q.share_code === code && q.id !== quizId)
    ) {
      return { data: null, error: { message: "code_collision" } };
    }
    if (action === "regenerate" && current == null) {
      return { data: null, error: { message: "not_shared" } };
    }

    quiz.share_code = code;
    return { data: { share_code: code }, error: null };
  }
}

/** Fresh student-play context: creator owns one quiz with two questions. */
export function makeStudentQuizContext(opts?: {
  sharedCode?: string | null;
  questions?: Row[];
}) {
  const client = new StudentFakeSupabase();
  const ownerId = "00000000-0000-4000-8000-0000000000a1";
  const quizId = "00000000-0000-4000-8000-0000000000b2";
  const q1 = "00000000-0000-4000-8000-0000000000c3";
  const q2 = "00000000-0000-4000-8000-0000000000d4";

  client.setUser(ownerId, "student");
  client.seedStudentQuiz({
    id: quizId,
    created_by: ownerId,
    title: "My Practice Quiz",
    description: "Chapter 1",
    share_code: opts?.sharedCode ?? null,
  });
  client.seedStudentQuestion({
    id: q1,
    quiz_id: quizId,
    order_index: 0,
    type: "mcq",
    prompt: "What is 2+2?",
    options: ["3", "4", "5", "6"],
    correct_index: 1,
    explanation: "Basic addition.",
  });
  client.seedStudentQuestion({
    id: q2,
    quiz_id: quizId,
    order_index: 1,
    type: "true_false",
    prompt: "Is 5 > 3?",
    options: ["True", "False"],
    correct_index: 0,
  });
  for (const q of opts?.questions ?? []) client.seedStudentQuestion(q);

  return { client, ownerId, quizId, q1, q2 };
}
