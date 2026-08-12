/**
 * Minimal in-memory fake Supabase client for route-handler tests.
 *
 * Implements just enough of the fluent query-builder surface that the route
 * handlers + REAL guards (`requireUser`, `requireClassOwner`,
 * `requireQuizOwner`) use, backed by plain in-memory tables. This lets tests
 * exercise the actual authZ logic (I20: student → 403) and validation paths
 * without a live DB.
 *
 * Session RPC branches (`start_quiz_session` / `answer_question` /
 * `submit_session`) are ROUTE-MAPPING STUBS ONLY — they must stay in lockstep
 * with migration `0008_sessions.sql`; the authoritative RPC-semantics checks
 * are `scripts/verify-sessions.mjs` (D-tests). The fake must NOT re-implement
 * the SQL timer (seeded `{error:'time_expired'}` via the `rpcResult` seam),
 * nor the DB constraint details beyond what the route-mapping branches need.
 *
 * NOT a production module — test-only, imported only by `*.test.ts`.
 */

type Row = Record<string, unknown> & { id?: string };

type TableMap = { [name: string]: Row[] };

type Op =
  | { kind: "insert"; row: Row }
  | { kind: "update"; row: Row }
  | { kind: "delete" };

class FakeQueryBuilder {
  private filters: { col: string; val: unknown; negated?: boolean }[] = [];
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN?: number;
  private countExact = false;
  private op?: Op;

  constructor(
    private client: FakeSupabase,
    private table: string,
  ) {}

  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ col, val, negated: true });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.count === "exact") this.countExact = true;
    return this;
  }

  insert(row: Row): this {
    this.op = { kind: "insert", row };
    return this;
  }

  update(row: Row): this {
    this.op = { kind: "update", row };
    return this;
  }

  delete(): this {
    this.op = { kind: "delete" };
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const { rows, error } = this._execute();
    return { data: error ? null : rows[0] ?? null, error };
  }

  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const { rows, error } = this._execute();
    if (error) return { data: null, error };
    if (rows.length === 0) return { data: null, error: { message: "PGRST116" } };
    return { data: rows[0], error: null };
  }

  /** Thenable so `await builder` works for count queries (publish route). */
  then(
    resolve: (value: { count?: number; data?: Row[]; error: { message: string } | null }) => void,
  ): void {
    const { rows, error } = this._execute();
    // Match PostgREST's real shape: count queries return { count, data, error },
    // plain queries return { data, error }.
    if (error) resolve({ count: undefined, data: undefined, error });
    else if (this.countExact) resolve({ count: rows.length, data: rows, error: null });
    else resolve({ data: rows, error: null });
  }

  private _filtered(rows: Row[]): Row[] {
    let out = rows;
    for (const f of this.filters) {
      // Support PostgREST embedded filters (`classes.lecturer_id = x`) used by
      // requireQuizOwner's `classes!inner(lecturer_id)` join. Resolve the FK
      // from the current row into the referenced table, then compare.
      const dot = f.col.indexOf(".");
      if (dot > 0) {
        const [refTable, refCol] = [f.col.slice(0, dot), f.col.slice(dot + 1)];
        out = out.filter((r) => {
          // quizzes.class_id → classes.id (the only embedded join in use).
          const fkCol = this.table === "quizzes" && refTable === "classes" ? "class_id" : null;
          if (!fkCol) {
            // Fail the test rather than silently skip an unknown authz filter —
            // a future embedded join (e.g. questions!inner) must be modeled
            // here explicitly, or an authz regression could go green.
            throw new Error(
              `FakeQueryBuilder: unsupported embedded filter "${f.col}" on table "${this.table}"`,
            );
          }
          const fkVal = r[fkCol];
          const refRow = (this.client.tables[refTable] ?? []).find(
            (x) => x.id === fkVal,
          );
          const match = refRow?.[refCol] === f.val;
          return f.negated ? !match : match;
        });
      } else {
        out = out.filter((r) => {
          const match = r[f.col] === f.val;
          return f.negated ? !match : match;
        });
      }
    }
    if (this.orderBy.length) {
      const { col, asc } = this.orderBy[0];
      out = [...out].sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        return asc ? av - bv : bv - av;
      });
    }
    if (this.limitN !== undefined) out = out.slice(0, this.limitN);
    return out;
  }

  private _execute(): { rows: Row[]; error: { message: string } | null } {
    // Test-only error seam: when set, every WRITE operation (insert/update/
    // delete) on this table returns the seeded error so the route's
    // error-mapping branches can be exercised (e.g. trigger errors on
    // UPDATE). SELECTs pass through (the seam is for writes only).
    if (this.client.updateError && this.op && this.op.kind !== undefined) {
      return { rows: [], error: { message: this.client.updateError } };
    }
    // Count-only error seam (publish / quiz-DELETE session-count pre-checks).
    if (this.client.countError && this.countExact) {
      return { rows: [], error: { message: this.client.countError } };
    }
    const tableRows = (this.client.tables[this.table] ??= []);

    if (!this.op) {
      return { rows: this._filtered(tableRows), error: null };
    }

    if (this.op.kind === "insert") {
      const r: Row = { ...this.op.row, id: this.op.row.id ?? randomUuid() };
      tableRows.push(r);
      return { rows: [r], error: null };
    }

    const op = this.op;
    const targets = this._filtered(tableRows);

    if (op.kind === "update") {
      targets.forEach((r) => Object.assign(r, op.row));
      return { rows: targets, error: null };
    }

    // delete
    this.client.tables[this.table] = tableRows.filter((r) => !targets.includes(r));
    return { rows: targets, error: null };
  }
}

function randomUuid(): string {
  return crypto.randomUUID();
}

export class FakeSupabase {
  tables: TableMap = {};
  user: { id: string } | null = null;
  profileRole: "lecturer" | "student" | null = null;
  rpcResult: { data: unknown; error: { message: string } | null } = {
    data: null,
    error: null,
  };
  /** Fake storage files keyed by object path. */
  storageFiles: Record<string, Uint8Array> = {};
  /** When true, replace_quiz_questions returns an error (simulated). */
  rpcError: { message: string } | null = null;
  /**
   * Test-only: when set, every `.update()`/`.delete()`/etc. on this table
   * returns the seeded error so the route's error-mapping branches can be
   * exercised (e.g. trigger errors on UPDATE).
   */
  updateError: string | null = null;
  /**
   * Test-only: when set, `count: "exact"` queries (the publish/quiz-DELETE
   * session-count pre-checks) return this error so the route's 503 branch can
   * be exercised (SELECTs otherwise pass through).
   */
  countError: string | null = null;

  auth = {
    getUser: async () => ({ data: { user: this.user } }),
  };

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }

  // rpc() models the RPCs the routes call:
  //  - append_question: appends with order_index = max+1.
  //  - replace_quiz_questions: atomic replace (delete + insert + quiz update).
  //  - start_quiz_session / answer_question / submit_session: route-mapping
  //    stubs (see header comment) modeling real semantics at the level the
  //    routes branch on.
  //  - reorder_questions / others: return the pre-seeded rpcResult.
  async rpc(name: string, args?: Record<string, unknown>) {
    if (name === "start_quiz_session") {
      return this._startQuizSession(args);
    }
    if (name === "answer_question") {
      return this._answerQuestion(args);
    }
    if (name === "submit_session") {
      return this._submitSession(args);
    }
    if (name === "append_question") {
      const questions = this.tables["questions"] ?? [];
      const quizId = String(args?.p_quiz_id);
      const maxIdx = questions.reduce(
        (m, q) => (q.quiz_id === quizId ? Math.max(m, (q.order_index as number) ?? -1) : m),
        -1,
      );
      const row: Row = {
        id: randomUuid(),
        quiz_id: quizId,
        order_index: maxIdx + 1,
        type: args?.p_type,
        prompt: args?.p_prompt,
        options: args?.p_options,
        correct_index: args?.p_correct_index,
        explanation: args?.p_explanation ?? null,
        created_at: "2026-01-01T00:00:00Z",
      };
      this.tables["questions"] = [...questions, row];
      return { data: row, error: null };
    }

    if (name === "replace_quiz_questions") {
      if (this.rpcError) return { data: null, error: this.rpcError };
      const quizId = String(args?.p_quiz_id);
      const questions = (this.tables["questions"] ?? []).filter((q) => q.quiz_id !== quizId);
      // The route passes p_questions as an ARRAY; PostgREST serializes the jsonb
      // arg. Parse JSON strings for robustness against future regressions.
      const raw = args?.p_questions;
      const parsed: unknown[] =
        typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
      const rows = parsed.map((q, i) => {
        const row = q as Row;
        return {
          id: randomUuid(),
          quiz_id: quizId,
          order_index: i,
          type: row.type,
          prompt: row.prompt,
          options: row.options,
          correct_index: row.correct_index,
          explanation: row.explanation ?? null,
          created_at: "2026-01-01T00:00:00Z",
        };
      });
      this.tables["questions"] = [...questions, ...rows];
      // Update the quiz row's title/source fields.
      const quizRow = (this.tables["quizzes"] ?? []).find((q) => q.id === quizId);
      if (quizRow) {
        if (args?.p_title) quizRow.title = String(args.p_title);
        if (args?.p_source_file_url !== undefined) quizRow.source_file_url = args.p_source_file_url;
        if (args?.p_source_text !== undefined) quizRow.source_text = args.p_source_text;
      }
      return { data: rows, error: null };
    }

    return this.rpcResult;
  }

  // ── session RPC stubs (route-mapping only; see header comment) ──
  /**
   * start_quiz_session — models practice rejoin-or-insert and assessment
   * one-attempt semantics at the level the routes branch on. Returns the
   * same jsonb shape as the real RPC (`{session}` / `{error, session_id}`).
   */
  private async _startQuizSession(args?: Record<string, unknown>) {
    // Test seam: an explicitly seeded rpcResult overrides the stub (used to
    // exercise error-mapping branches without re-modeling the real RPC).
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const quizId = String(args?.p_quiz_id);
    const studentId = this.user?.id ?? "";
    const sessions = (this.tables["quiz_sessions"] ??= []);
    const quizzes = this.tables["quizzes"] ?? [];

    // If the quiz is not live, the real RPC returns quiz_not_live.
    const quiz = quizzes.find((q) => q.id === quizId);
    if (!quiz || quiz.status !== "live") {
      return { data: { error: "quiz_not_live" }, error: null };
    }

    const mode = (quiz.mode as string) ?? "practice";

    if (mode === "practice") {
      const existing = sessions.find(
        (s) =>
          s.quiz_id === quizId &&
          s.student_id === studentId &&
          (s.status === "active" || s.status === "paused"),
      );
      if (existing) {
        return { data: { session: existing }, error: null };
      }
      const row: Row = {
        id: randomUuid(),
        quiz_id: quizId,
        student_id: studentId,
        mode: "practice",
        status: "active",
        started_at: "2026-01-01T00:00:00Z",
        submitted_at: null,
        score: null,
        last_activity_at: "2026-01-01T00:00:00Z",
      };
      sessions.push(row);
      return { data: { session: row }, error: null };
    }

    // assessment: one-attempt.
    const existing = sessions.find(
      (s) => s.quiz_id === quizId && s.student_id === studentId && s.mode === "assessment",
    );
    if (existing) {
      return { data: { error: "already_attempted", session_id: existing.id }, error: null };
    }
    const row: Row = {
      id: randomUuid(),
      quiz_id: quizId,
      student_id: studentId,
      mode: "assessment",
      status: "active",
      started_at: "2026-01-01T00:00:00Z",
      submitted_at: null,
      score: null,
      last_activity_at: "2026-01-01T00:00:00Z",
    };
    sessions.push(row);
    return { data: { session: row }, error: null };
  }

  /**
   * answer_question — models assessment conflict → already_answered (existing
   * is_correct), practice upsert, and error-branch payloads. The SQL timer is
   * NOT re-implemented: seeded `{error:'time_expired'}` goes through the
   * `rpcResult` seam (I9), and `session_not_active`/`not_owner` come from the
   * seeded session row's status / ownership.
   */
  private async _answerQuestion(args?: Record<string, unknown>) {
    // Test seam: an explicitly seeded rpcResult overrides the stub (used to
    // seed `{error:'time_expired'}` for I9 — the SQL timer is NOT re-modeled).
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const studentId = this.user?.id ?? "";
    const sessions = this.tables["quiz_sessions"] ?? [];
    const session = sessions.find(
      (s) => s.id === sessionId && s.student_id === studentId,
    );
    if (!session) {
      return { data: { error: "not_owner" }, error: null };
    }
    if (session.status !== "active") {
      return { data: { error: "session_not_active" }, error: null };
    }

    const questionId = String(args?.p_question_id);
    const selectedIndex = args?.p_selected_index as number | undefined;
    const answers = (this.tables["session_answers"] ??= []);

    // Resolve correctness against the seeded question's correct_index.
    const question = (this.tables["questions"] ?? []).find(
      (q) => q.id === questionId && q.quiz_id === session.quiz_id,
    );
    if (!question) {
      return { data: { error: "invalid_question" }, error: null };
    }
    const options = (question.options as string[]) ?? [];
    if (
      selectedIndex === undefined ||
      selectedIndex === null ||
      selectedIndex < 0 ||
      selectedIndex >= options.length
    ) {
      return { data: { error: "invalid_selected_index" }, error: null };
    }

    const isCorrect = selectedIndex === (question.correct_index as number);
    const mode = session.mode as string;
    const existing = answers.find(
      (a) => a.session_id === sessionId && a.question_id === questionId,
    );

    if (mode === "assessment" && existing) {
      return { data: { error: "already_answered", is_correct: existing.is_correct }, error: null };
    }

    if (existing) {
      existing.selected_index = selectedIndex;
      existing.is_correct = isCorrect;
      existing.answered_at = "2026-01-01T00:01:00Z";
      return {
        data:
          mode === "assessment"
            ? { is_correct: isCorrect }
            : {
                is_correct: isCorrect,
                correct_index: question.correct_index,
                explanation: question.explanation ?? null,
              },
        error: null,
      };
    }

    const row: Row = {
      id: randomUuid(),
      session_id: sessionId,
      question_id: questionId,
      selected_index: selectedIndex,
      is_correct: isCorrect,
      answered_at: "2026-01-01T00:01:00Z",
    };
    answers.push(row);
    return {
      data:
        mode === "assessment"
          ? { is_correct: isCorrect }
          : {
              is_correct: isCorrect,
              correct_index: question.correct_index,
              explanation: question.explanation ?? null,
            },
      error: null,
    };
  }

  /**
   * submit_session — models idempotent already_submitted + score from answers.
   * Marks the session completed and sets submitted_at, mirroring the RPC.
   */
  private async _submitSession(args?: Record<string, unknown>) {
    // Test seam: an explicitly seeded rpcResult overrides the stub.
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const studentId = this.user?.id ?? "";
    const sessions = this.tables["quiz_sessions"] ?? [];
    const session = sessions.find(
      (s) => s.id === sessionId && s.student_id === studentId,
    );
    if (!session) {
      return { data: { error: "not_owner" }, error: null };
    }

    const answers = this.tables["session_answers"] ?? [];
    const total = (this.tables["questions"] ?? []).filter(
      (q) => q.quiz_id === session.quiz_id,
    ).length;

    if (session.status === "completed") {
      return {
        data: {
          session,
          score: session.score ?? 0,
          total,
          already_submitted: true,
        },
        error: null,
      };
    }

    if (session.status !== "active") {
      return { data: { error: "session_not_active" }, error: null };
    }

    const score = answers.filter(
      (a) => a.session_id === sessionId && a.is_correct === true,
    ).length;
    session.status = "completed";
    session.score = score;
    session.submitted_at = "2026-01-01T00:02:00Z";
    return { data: { session, score, total }, error: null };
  }

  /** Seed a session row (I-S12 / session route tests). */
  seedSession(session: Row) {
    this.tables["quiz_sessions"] ??= [];
    this.tables["quiz_sessions"].push(session);
  }

  /** Seed an answer row (I10 / submit tests). */
  seedAnswer(answer: Row) {
    this.tables["session_answers"] ??= [];
    this.tables["session_answers"].push(answer);
  }

  // ── test setup helpers ────────────────────────────────────────
  setUser(id: string, role: "lecturer" | "student") {
    this.user = { id };
    this.profileRole = role;
    this.tables["profiles"] ??= [];
    const idx = this.tables["profiles"].findIndex((p) => p.id === id);
    const row: Row = { id, role };
    if (idx >= 0) this.tables["profiles"][idx] = row;
    else this.tables["profiles"].push(row);
  }

  seedClass(id: string, lecturerId: string) {
    this.tables["classes"] ??= [];
    this.tables["classes"].push({ id, lecturer_id: lecturerId });
  }

  seedQuiz(quiz: Row) {
    this.tables["quizzes"] ??= [];
    this.tables["quizzes"].push(quiz);
  }

  seedQuestion(question: Row) {
    this.tables["questions"] ??= [];
    this.tables["questions"].push(question);
  }

  /** Seed a fake stored file for storage.download (I16b). */
  seedStorageFile(path: string, bytes: Uint8Array) {
    this.storageFiles[path] = bytes;
  }

  storage = {
    from: () => ({
      download: async (path: string) => {
        const bytes = this.storageFiles[path];
        if (!bytes) {
          return { data: null, error: { message: "Object not found", statusCode: "404" } };
        }
        const blob = new Blob([bytes as unknown as BlobPart], {
          type: "application/pdf",
        });
        return { data: blob, error: null };
      },
    }),
  };
}

/** Build a fresh fake client with a lecturer owner + owned class/quiz. */
export function makeOwnerContext(opts?: {
  quizStatus?: "draft" | "live" | "closed";
  questions?: Row[];
}) {
  const client = new FakeSupabase();
  const ownerId = "00000000-0000-4000-8000-00000000000a";
  const classId = "00000000-0000-4000-8000-00000000000b";
  const quizId = "00000000-0000-4000-8000-00000000000c";
  const questionId = "00000000-0000-4000-8000-00000000000d";

  client.setUser(ownerId, "lecturer");
  client.seedClass(classId, ownerId);
  client.seedQuiz({
    id: quizId,
    class_id: classId,
    created_by: ownerId,
    title: "Test Quiz",
    mode: "practice",
    status: opts?.quizStatus ?? "draft",
    time_limit_sec: null,
    source_file_url: null,
    source_text: null,
    created_at: "2026-01-01T00:00:00Z",
  });
  for (const q of opts?.questions ?? []) client.seedQuestion(q);

  return { client, ownerId, classId, quizId, questionId };
}
