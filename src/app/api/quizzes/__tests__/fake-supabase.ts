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
  private filters: (
    | { col: string; val: unknown; negated?: boolean }
    | { col: string; val: unknown[]; list: true }
  )[] = [];
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN?: number;
  private countExact = false;
  private op?: Op;
  private selectCols?: string[];

  constructor(
    private client: FakeSupabase,
    private table: string,
  ) {}

  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }

  /** PostgREST `is` — matches a value OR NULL (Supabase uses `is(col, null)`). */
  is(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ col, val, negated: true });
    return this;
  }

  /**
   * PostgREST `not` — currently `is`/`neq` operators (the only route uses).
   * Lockstep note: rows missing the key entirely behave as JS-undefined
   * (matches SQL three-valued logic only when tests seed the column
   * explicitly, e.g. image_path: null) — see the duplicate-route tests.
   */
  not(col: string, op: string, val: unknown): this {
    if (op === "is") return this.neq(col, val);
    if (op === "neq") return this.eq(col, val);
    throw new Error(`fake-supabase: .not(${op}) not implemented`);
  }

  /** PostgREST `in` — membership over a list of values. */
  in(col: string, values: unknown[]): this {
    this.filters.push({ col, val: values, list: true });
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

  select(cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.count === "exact") this.countExact = true;
    // Project the requested columns (a `select("a, b")` drops the rest) so
    // tests can pin column-level secrecy (e.g. the GET session route omitting
    // verify_nonce for lecturers). `*` / empty keeps all columns.
    if (cols && cols.trim() !== "*") {
      this.selectCols = cols.split(",").map((c) => c.trim()).filter(Boolean);
    }
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

  private _project(out: Row[]): Row[] {
    if (!this.selectCols) return out;
    return out.map((r) => {
      const projected: Row = {};
      for (const c of this.selectCols!) {
        if (c in r) projected[c] = r[c];
      }
      return projected;
    });
  }

  private _filtered(rows: Row[]): Row[] {
    return this._project(this._filterRaw(rows));
  }

  /** Filter/sort/limit WITHOUT projection — keeps original row references. */
  private _filterRaw(rows: Row[]): Row[] {
    let out = rows;
    for (const f of this.filters) {
      // Support PostgREST embedded filters (`classes.lecturer_id = x`) used by
      // requireQuizOwner's `classes!inner(lecturer_id)` join. Resolve the FK
      // from the current row into the referenced table, then compare.
      const dot = f.col.indexOf(".");
      if (dot > 0 && !("list" in f)) {
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
      } else if ("list" in f) {
        out = out.filter((r) => f.val.includes(r[f.col]));
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
    // Read-error seam (fail-closed SELECT arms, e.g. duplicate image phase).
    if (
      this.client.selectError &&
      this.client.selectErrorTable === this.table &&
      !this.op &&
      !this.countExact
    ) {
      return { rows: [], error: { message: this.client.selectError } };
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
    // WRITE targets must be the ORIGINAL row references (mutating/deleting
    // projected copies would leave the table rows untouched). `_filterRaw` is
    // `_filtered` WITHOUT the selectCols projection.
    const targets = this._filterRaw(tableRows);

    if (op.kind === "update") {
      targets.forEach((r) => Object.assign(r, op.row));
      return { rows: this._project(targets), error: null };
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
  /** resolve_question_image stub decisions (media routes). */
  resolvedImages: Record<string, { image_path: string; ttl_seconds: number }> = {};
  /** When true, replace_quiz_questions returns an error (simulated). */
  rpcError: { message: string } | null = null;
  /**
   * Test-only: when set, EVERY write op (insert/update/delete) on ANY table
   * returns the seeded error so the route's error-mapping branches can be
   * exercised (e.g. trigger errors on UPDATE). The seam is GLOBAL, not
   * per-table — a test that mixes successful writes with a seeded write
   * failure cannot distinguish them.
   */
  updateError: string | null = null;
  /**
   * Test-only: when set, `count: "exact"` queries (the publish/quiz-DELETE
   * session-count pre-checks) return this error so the route's 503 branch can
   * be exercised (SELECTs otherwise pass through).
   */
  countError: string | null = null;
  /**
   * Test-only: when set, plain SELECT queries (no write op, no count) on
   * `selectErrorTable` return this error — used to exercise read-failure
   * arms like the duplicate route's fail-closed image-phase select. Table-
   * scoped so earlier guard reads (profiles/quizzes/classes) still succeed.
   */
  selectError: string | null = null;
  selectErrorTable: string | null = null;

  auth = {
    getUser: async () => ({ data: { user: this.user } }),
  };

  from(table: string): FakeQueryBuilder {
    // The app now reads sessions/answers through the sealed views
    // (PLAN_REVEAL_RESULTS v4 §3). The fake models them as the base table
    // unless a test explicitly seeds the view table (e.g. to simulate the
    // reveal-gated score). This keeps the route's view-based reads working
    // with the same in-memory rows.
    const VIEW_TO_BASE: Record<string, string> = {
      student_session_view: "quiz_sessions",
      lecturer_session_view: "quiz_sessions",
      student_answers_view: "session_answers",
      lecturer_answers_view: "session_answers",
      student_quiz_view: "quizzes",
    };
    const resolved = VIEW_TO_BASE[table] ?? table;
    return new FakeQueryBuilder(this, resolved);
  }

  // rpc() models the RPCs the routes call:
  //  - append_question: appends with order_index = max+1.
  //  - replace_quiz_questions: atomic replace (delete + insert + quiz update).
  //  - start_quiz_session / answer_question / submit_session: route-mapping
  //    stubs (see header comment) modeling real semantics at the level the
  //    routes branch on.
  //  - face RPCs (enroll_face / record_face_check / self_recover_session /
  //    pause_session / unlock_session / exempt_face_session /
  //    report_face_unavailable / revoke_face_consent): route-mapping stubs —
  //    must stay in lockstep with migration 0009_face.sql; the authoritative
  //    RPC-semantics checks are scripts/verify-face.mjs.
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
    if (name === "record_face_check") {
      return this._recordFaceCheck(args);
    }
    if (name === "enroll_face") {
      return this._enrollFace(args);
    }
    if (name === "self_recover_session") {
      return this._selfRecoverSession(args);
    }
    if (name === "pause_session") {
      return this._pauseSession(args);
    }
    if (name === "report_session_advisory") {
      return this._reportSessionAdvisory(args);
    }
    if (name === "unlock_session") {
      return this._unlockSession(args);
    }
    if (name === "exempt_face_session") {
      return this._exemptFaceSession(args);
    }
    if (name === "report_face_unavailable") {
      return this._reportFaceUnavailable(args);
    }
    if (name === "reset_session") {
      return this._resetSession(args);
    }
    if (name === "grant_face_consent") {
      return this._grantFaceConsent();
    }
    if (name === "revoke_face_consent") {
      return this._revokeFaceConsent();
    }
    if (name === "confirm_face_subject_deleted") {
      return this._confirmFaceSubjectDeleted();
    }
    if (name === "reject_face_enrollment") {
      return this._rejectFaceEnrollment(args);
    }
    if (name === "is_lecturer_of_quiz") {
      // Mirror the SQL helper (0004): gate on the quiz's CLASS ownership, not
      // quiz.created_by (class ownership is what RLS + reset_session enforce).
      const quizId = String(args?.p_quiz_id);
      const quiz = (this.tables["quizzes"] ?? []).find((q) => q.id === quizId);
      const cls = quiz ? (this.tables["classes"] ?? []).find((c) => c.id === quiz.class_id) : undefined;
      return { data: cls?.lecturer_id === this.user?.id, error: null };
    }
    if (name === "clone_quiz") {
      return this._cloneQuiz(args);
    }
    if (name === "resolve_question_image") {
      // Media visibility stub (0028): returns the seeded decision or an EMPTY
      // array — never a path for unseeded ids. Lockstep note in seedResolvedImage.
      const questionId = String(args?.p_question_id ?? "");
      const entry = this.resolvedImages[questionId];
      return { data: entry ? [entry] : [], error: null };
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

    if (name === "save_quiz_questions" || name === "replace_quiz_questions") {
      if (this.rpcError) return { data: null, error: this.rpcError };
      const quizId = String(args?.p_quiz_id);
      const mode = (args?.p_mode as string) ?? "replace";
      const allQuestions = this.tables["questions"] ?? [];
      const quizQuestions = allQuestions.filter((q) => q.quiz_id === quizId);
      const otherQuestions = allQuestions.filter((q) => q.quiz_id !== quizId);

      const raw = args?.p_questions;
      const parsed: unknown[] =
        typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];

      if (mode === "append" && quizQuestions.length + parsed.length > 30) {
        return { data: null, error: { message: "quiz_question_limit_exceeded" } };
      }

      const startIndex =
        mode === "replace"
          ? 0
          : quizQuestions.reduce(
              (m, q) => Math.max(m, (q.order_index as number) ?? -1),
              -1,
            ) + 1;

      const rows = parsed.map((q, i) => {
        const row = q as Row;
        return {
          id: randomUuid(),
          quiz_id: quizId,
          order_index: startIndex + i,
          type: row.type,
          prompt: row.prompt,
          options: row.options,
          correct_index: row.correct_index,
          explanation: row.explanation ?? null,
          created_at: "2026-01-01T00:00:00Z",
        };
      });

      this.tables["questions"] =
        mode === "replace"
          ? [...otherQuestions, ...rows]
          : [...allQuestions, ...rows];

      // Update the quiz row's title/source fields.
      const quizRow = (this.tables["quizzes"] ?? []).find((q) => q.id === quizId);
      if (quizRow) {
        const sourceEntry =
          args?.p_source_file_url || args?.p_source_text
            ? {
                file_url: args.p_source_file_url ?? null,
                added_at: "2026-01-01T00:00:00Z",
                question_count: parsed.length,
                mode,
              }
            : null;

        if (args?.p_title && (mode === "replace" || !quizRow.title)) quizRow.title = String(args.p_title);
        if (mode === "replace") {
          quizRow.source_file_url = args?.p_source_file_url ?? null;
          quizRow.sources = sourceEntry ? [sourceEntry] : [];
        } else {
          if (args?.p_source_file_url) quizRow.source_file_url = args.p_source_file_url;
          const existingSources = Array.isArray(quizRow.sources) ? quizRow.sources : [];
          quizRow.sources = sourceEntry ? [...existingSources, sourceEntry] : existingSources;
        }

        // 0025:161-185 semantics: replace overwrites the source fields
        // wholesale (nulls clear them); append concatenates only NON-EMPTY
        // new text — an explicit NULL leaves existing text byte-identical.
        if (mode === "replace") {
          if (args?.p_source_text !== undefined) {
            quizRow.source_text = args.p_source_text ?? null;
          }
        } else if (args?.p_source_text) {
          quizRow.source_text = quizRow.source_text
            ? `${quizRow.source_text}\n\n--- [Additional Source Material] ---\n\n${args.p_source_text}`
            : args.p_source_text;
        }
      }
      return { data: rows, error: null };
    }

    return this.rpcResult;
  }

  /**
   * clone_quiz — route-mapping stub in lockstep with migration 0035
   * (AP-2). Ownership gates mirror the SQL order: source class ownership
   * first (covers missing + foreign alike → not_quiz_owner), destination
   * ownership (not_class_owner), archived destination (class_archived).
   * The authoritative clone-fidelity checks live in scripts/verify-clone-quiz.mjs.
   */
  private _cloneQuiz(args?: Record<string, unknown>) {
    // Test seam: an explicitly seeded rpcError/rpcResult overrides the stub
    // (error-mapping branches without re-modeling the real RPC).
    if (this.rpcError) return { data: null, error: this.rpcError };
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const srcId = String(args?.p_src_quiz_id);
    const destClassId = String(args?.p_dest_class_id);

    const quizzes = (this.tables["quizzes"] ??= []);
    const src = quizzes.find((q) => q.id === srcId);
    const srcClass = src
      ? (this.tables["classes"] ?? []).find((c) => c.id === src.class_id)
      : undefined;
    if (!src || srcClass?.lecturer_id !== this.user?.id) {
      return { data: null, error: { message: "not_quiz_owner" } };
    }

    const destClass = (this.tables["classes"] ?? []).find((c) => c.id === destClassId);
    if (!destClass || destClass.lecturer_id !== this.user?.id) {
      return { data: null, error: { message: "not_class_owner" } };
    }
    if (destClass.archived_at) {
      return { data: null, error: { message: "class_archived" } };
    }

    const newId = randomUuid();
    // Title carries the " (copy)" suffix trimmed to the 200-char CHECK.
    const baseTitle = String(src.title ?? "").trim();
    const clone: Row = {
      ...src,
      id: newId,
      class_id: destClassId,
      created_by: this.user?.id,
      title: `${baseTitle.slice(0, 200 - 7)} (copy)`,
      status: "draft",
      // Fresh-state fields: 0035 copies metadata but never linkage/session
      // state, file provenance, windows, or reveal timestamps.
      results_revealed_at: null,
      opens_at: null,
      closes_at: null,
      source_file_url: null,
      sources: [],
      created_at: "2026-01-01T00:00:00Z",
    };
    quizzes.push(clone);

    const questions = (this.tables["questions"] ??= []);
    for (const q of questions.filter((q) => q.quiz_id === srcId)) {
      questions.push({ ...q, id: randomUuid(), quiz_id: newId });
    }
    return { data: newId, error: null };
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

    // Window gating (0030 lockstep): enrolled callers get distinct schedule
    // errors; the fake treats every setUser() caller as enrolled (enrollment
    // semantics are a verify-harness concern, not a route-mapping one).
    const now = Date.now();
    if (typeof quiz.opens_at === "string" && now < Date.parse(quiz.opens_at)) {
      return { data: { error: "quiz_not_open" }, error: null };
    }
    if (typeof quiz.closes_at === "string" && now >= Date.parse(quiz.closes_at)) {
      return { data: { error: "quiz_window_closed" }, error: null };
    }

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
        attempt: 1,
        started_at: "2026-01-01T00:00:00Z",
        submitted_at: null,
        score: null,
        last_activity_at: "2026-01-01T00:00:00Z",
      };
      sessions.push(row);
      return { data: { session: row }, error: null };
    }

    // assessment: resume-or-void-or-spawn (0032 lockstep). Resume/already
    // semantics at route-mapping level: any existing assessment session →
    // already_attempted with its id (the SQL stale-void path is a
    // verify-harness concern, not a route-mapping one). The budget-exhausted
    // branch returns the latest completed session id (legacy shape — the
    // client lands on the completed session's EndScreen).
    const mine = sessions.filter(
      (s) => s.quiz_id === quizId && s.student_id === studentId && s.mode === "assessment",
    );
    const existing =
      mine.find((s) => ["active", "paused", "flagged"].includes(s.status as string)) ??
      mine[mine.length - 1];
    if (existing) {
      return { data: { error: "already_attempted", session_id: existing.id }, error: null };
    }
    const row: Row = {
      id: randomUuid(),
      quiz_id: quizId,
      student_id: studentId,
      mode: "assessment",
      status: "active",
      attempt: 1,
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

    // Live gate (0012:199-208 lockstep) BEFORE the window term: a closed/draft
    // quiz folds to quiz_not_live exactly like the real RPC.
    const quizRow = (this.tables["quizzes"] ?? []).find((q) => q.id === session.quiz_id);
    if (!quizRow || quizRow.status !== "live") {
      return { data: { error: "quiz_not_live" }, error: null };
    }

    // Window hard stop (0030 lockstep): closes_at passed → quiz_window_closed.
    if (
      typeof quizRow?.closes_at === "string" &&
      Date.now() >= Date.parse(quizRow.closes_at as string)
    ) {
      return { data: { error: "quiz_window_closed" }, error: null };
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
      return { data: { error: "already_answered" }, error: null };
    }

    if (existing) {
      existing.selected_index = selectedIndex;
      existing.is_correct = isCorrect;
      existing.answered_at = "2026-01-01T00:01:00Z";
      return {
        data:
          mode === "assessment"
            ? { recorded: true }
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
          ? { recorded: true }
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

    // Reveal gate (PLAN v4): assessment score is NULL until the quiz's
    // results are released. The fake models the RPC reading the quiz row's
    // results_revealed_at (auto-reveal aside — route tests seed it directly).
    const mode = session.mode as string;
    const quiz = (this.tables["quizzes"] ?? []).find((q) => q.id === session.quiz_id);
    const revealed =
      mode !== "assessment" || quiz?.results_revealed_at != null;
    const payloadScore = revealed ? session.score ?? 0 : null;
    const payloadTotal = revealed ? total : null;

    if (session.status === "completed") {
      return {
        data: {
          session,
          score: payloadScore,
          total: payloadTotal,
          already_submitted: true,
        },
        error: null,
      };
    }

    // P7 redefined submit_session: `active`/`paused` submit; `flagged` rejects.
    if (session.status === "flagged") {
      return { data: { error: "session_not_active" }, error: null };
    }

    const score = answers.filter(
      (a) => a.session_id === sessionId && a.is_correct === true,
    ).length;
    session.status = "completed";
    session.score = score;
    session.submitted_at = "2026-01-01T00:02:00Z";
    return {
      data: { session, score: revealed ? score : null, total: revealed ? total : null },
      error: null,
    };
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
    this.tables["classes"].push({ id, title: "Test Class", lecturer_id: lecturerId });
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

  /**
   * Seeded visibility decisions for the resolve_question_image RPC stub
   * (media routes). Keyed by question id; STUBS ONLY — the authoritative
   * matrix checks live in scripts/verify-media.mjs (lockstep with 0028).
   */
  seedResolvedImage(questionId: string, entry: { image_path: string; ttl_seconds: number }) {
    this.resolvedImages[questionId] = entry;
  }

  // ── Phase 7 face helpers ──────────────────────────────────────────
  /** Seed a profile with consent/enrollment (face tests). */
  seedProfile(row: Row) {
    this.tables["profiles"] ??= [];
    const idx = this.tables["profiles"].findIndex((p) => p.id === row.id);
    if (idx >= 0) this.tables["profiles"][idx] = { ...this.tables["profiles"][idx], ...row };
    else this.tables["profiles"].push(row);
  }

  /** Seed a face_checks row (window tests). */
  seedFaceCheck(row: Row) {
    this.tables["face_checks"] ??= [];
    this.tables["face_checks"].push(row);
  }

  /** Seed an audit_events row. */
  seedAuditEvent(row: Row) {
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push(row);
  }

  // ── Phase 7 face RPC stubs (route-mapping only; see header comment) ──

  /** enroll_face — consent gate + status derive from CompreFace metadata + audit. */
  private async _enrollFace(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const studentId = this.user?.id ?? "";
    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === studentId);
    if (!profile) return { data: { error: "not_student" }, error: null };
    if (!profile.consent_given_at) return { data: { error: "consent_required" }, error: null };

    // live_assessment: ever-enrolled + an in-progress assessment session.
    const ever = profile.face_enrollment_status != null ||
      (this.tables["audit_events"] ?? []).some(
        (a) => a.actor_id === studentId && (a.action === "face_enroll" || a.action === "face_reenroll"),
      );
    const live = (this.tables["quiz_sessions"] ?? []).some(
      (s) => s.student_id === studentId && s.mode === "assessment" && ["active", "paused", "flagged"].includes(s.status as string),
    );
    if (live && ever) return { data: { error: "live_assessment" }, error: null };

    // Derive status from CompreFace duplicate-check metadata (mirror 0010):
    // similarity ≥ 0.45 against a DIFFERENT subject → pending_review. SQL uses
    // `coalesce(p_duplicate_subject,'') <> auth.uid()::text` — a NULL/empty
    // subject with high similarity is `pending_review` (never self-clean).
    const dupSim = args?.p_duplicate_similarity == null ? 0 : Number(args?.p_duplicate_similarity);
    const dupSubject = args?.p_duplicate_subject == null ? "" : String(args?.p_duplicate_subject);
    const status = dupSim >= 0.45 && dupSubject !== studentId ? "pending_review" : "enrolled";

    profile.face_enrollment_status = status;
    // Lockstep with 0010_compreface.sql: a successful enroll also clears any
    // leftover consent-revoke deletion-pending marker.
    profile.face_deletion_pending = false;
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: studentId,
      subject_id: studentId,
      action: ever ? "face_reenroll" : "face_enroll",
      metadata: { status },
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { ok: true, status }, error: null };
  }

  /**
   * record_face_check — models the FLAT last-5 window at the level the routes
   * branch on (success shape + error keys). The authoritative window logic is
   * verify-face.mjs (SQL); this stub mirrors `evaluateFaceCheck` semantics.
   */
  private async _recordFaceCheck(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const studentId = this.user?.id ?? "";
    const sessions = this.tables["quiz_sessions"] ?? [];
    const session = sessions.find((s) => s.id === sessionId && s.student_id === studentId);
    if (!session) return { data: { error: "not_owner" }, error: null };

    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === studentId);
    if (!profile?.consent_given_at) return { data: { error: "consent_required" }, error: null };
    if (session.mode !== "assessment") return { data: { error: "not_assessment" }, error: null };

    // quiz_not_live parity: quiz must be live.
    const quiz = (this.tables["quizzes"] ?? []).find((q) => q.id === session.quiz_id);
    if (!quiz || quiz.status !== "live") return { data: { error: "quiz_not_live" }, error: null };

    if (session.status === "completed") return { data: { error: "session_not_active" }, error: null };
    if (session.face_exempt) {
      return {
        data: {
          matched: true,
          distance: null,
          sessionStatus: session.status,
          nextNonce: session.verify_nonce,
          faceFailStreak: session.face_fail_streak,
        },
        error: null,
      };
    }
    if (session.status === "paused" || session.status === "flagged") {
      return { data: { error: "session_not_active" }, error: null };
    }

    // Enrollment required (mirror 0010: face_enrollment_status, not a dropped
    // embedding column). pending_review does NOT count as enrolled.
    if (!profile.face_enrollment_status || profile.face_enrollment_status === "pending_review") {
      return { data: { error: "not_enrolled" }, error: null };
    }

    const nonce = String(args?.p_nonce ?? "");
    if (session.verify_nonce !== nonce) return { data: { error: "nonce_mismatch" }, error: null };

    // Compute `matched` from per-frame votes + SQL constants (mirror 0020):
    // p_subject must equal the caller's uid AND a STRICT MAJORITY of the
    // submitted similarities ≥ 0.5. No `p_matched` parameter exists — never
    // caller-supplied.
    const subject = String(args?.p_subject ?? "");
    const similarities = Array.isArray(args?.p_similarities)
      ? (args.p_similarities as unknown[]).map((s) => Number(s ?? 0))
      : [];
    let hits = 0;
    for (const s of similarities) if (s >= 0.5) hits++;
    const matched =
      subject === studentId && similarities.length > 0 && hits * 2 > similarities.length;
    const distance = similarities.length > 0 ? 1 - Math.max(...similarities) : null;

    // Advisory flags: suspected_replay = the same frame hash as the previous
    // check (server-computed over the concatenated frames); too_frequent = a
    // previous check exists.
    const checks = (this.tables["face_checks"] ?? []).filter((c) => c.session_id === sessionId);
    const frames = Array.isArray(args?.p_frames) ? (args.p_frames as unknown[]) : [];
    const frameHash = `h-${frames.join("|")}`;
    const prevHash = checks[checks.length - 1]?.frame_hash;
    const suspectedReplay = frameHash !== "h-" && frameHash === prevHash;
    const tooFrequent = checks.length > 0;

    this.tables["face_checks"] ??= [];
    this.tables["face_checks"].push({
      id: randomUuid(),
      session_id: sessionId,
      checked_at: "2026-01-01T00:00:00Z",
      matched,
      distance,
      trigger: args?.p_trigger ?? "periodic",
      suspected_replay: suspectedReplay,
      too_frequent: tooFrequent,
      frame_hash: frameHash,
    });

    // FLAT last-5 window (mirrors lib/face/streak + SQL).
    const recent = [...checks, { matched }].slice(-5);
    let fails = 0;
    for (const c of recent) if (!c.matched) fails++;

    let status: "active" | "paused" | "flagged";
    if (matched) status = "active";
    else if (fails >= 3) status = "flagged";
    else status = "paused";

    const nextNonce = randomUuid();
    session.status = status;
    session.face_fail_streak = matched ? 0 : fails;
    session.verify_nonce = nextNonce;

    return {
      data: {
        matched,
        distance,
        sessionStatus: status,
        nextNonce,
        faceFailStreak: matched ? 0 : fails,
      },
      error: null,
    };
  }

  private async _selfRecoverSession(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const studentId = this.user?.id ?? "";
    const session = (this.tables["quiz_sessions"] ?? []).find(
      (s) => s.id === sessionId && s.student_id === studentId,
    );
    if (!session) return { data: { error: "not_owner" }, error: null };
    if (session.status === "completed") return { data: { error: "session_not_active" }, error: null };
    if (session.status === "flagged") return { data: { error: "flagged" }, error: null };
    if (session.status === "active") return { data: { sessionStatus: "active" }, error: null };
    session.status = "active";
    session.face_fail_streak = 0;
    const nextNonce = randomUuid();
    session.verify_nonce = nextNonce;
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: studentId,
      subject_id: studentId,
      action: "self_recover",
      metadata: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { sessionStatus: "active", nextNonce }, error: null };
  }

  private async _pauseSession(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const reason = args?.p_reason === undefined ? "hand_loss" : String(args.p_reason);
    const studentId = this.user?.id ?? "";
    const session = (this.tables["quiz_sessions"] ?? []).find(
      (s) => s.id === sessionId && s.student_id === studentId,
    );
    if (!session) return { data: { error: "not_owner" }, error: null };
    if (reason !== "hand_loss" && reason !== "focus_lost") {
      return { data: { error: "invalid_reason" }, error: null };
    }
    if (session.mode !== "assessment") return { data: { error: "not_assessment" }, error: null };
    if (session.status === "completed" || session.status === "flagged") {
      return { data: { error: "session_not_active" }, error: null };
    }
    let flagged = false;
    if (reason === "focus_lost") {
      session.focus_pause_count =
        ((session.focus_pause_count as number | undefined) ?? 0) + 1;
      flagged = (session.focus_pause_count as number) >= 3;
      if (flagged) {
        this.tables["audit_events"] ??= [];
        this.tables["audit_events"].push({
          id: randomUuid(),
          actor_id: studentId,
          subject_id: studentId,
          action: "auto_flag_focus_loss",
          metadata: { focus_pause_count: session.focus_pause_count },
          created_at: "2026-01-01T00:00:00Z",
        });
      }
    }
    if (flagged) {
      session.status = "flagged";
      return { data: { sessionStatus: "flagged" }, error: null };
    }
    if (session.status === "active") session.status = "paused";
    return { data: { sessionStatus: "paused" }, error: null };
  }

  private async _reportSessionAdvisory(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const type = String(args?.p_type);
    const VALID = ["second_face", "looked_away", "voice_activity", "headset_active"];
    const studentId = this.user?.id ?? "";
    const session = (this.tables["quiz_sessions"] ?? []).find(
      (s) => s.id === sessionId && s.student_id === studentId,
    );
    if (!VALID.includes(type)) return { data: { error: "invalid_type" }, error: null };
    if (
      !session ||
      session.mode !== "assessment" ||
      !(session.status === "active" || session.status === "paused")
    ) {
      return { data: { error: "not_owner" }, error: null };
    }
    this.tables["session_advisories"] ??= [];
    const existing = this.tables["session_advisories"].find(
      (a) => a.session_id === sessionId && a.adv_type === type,
    );
    if (existing) {
      existing.occurrences = ((existing.occurrences as number) ?? 1) + 1;
      existing.last_seen_at = new Date().toISOString();
    } else {
      this.tables["session_advisories"].push({
        id: randomUuid(),
        session_id: sessionId,
        adv_type: type,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        occurrences: 1,
      });
    }
    return { data: { ok: true }, error: null };
  }

  private async _unlockSession(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    if (this.profileRole !== "lecturer") return { data: { error: "not_lecturer" }, error: null };
    const session = (this.tables["quiz_sessions"] ?? []).find((s) => s.id === sessionId);
    if (!session) return { data: { error: "not_owner" }, error: null };
    if (session.status === "completed") return { data: { error: "session_not_active" }, error: null };
    session.status = "active";
    session.face_fail_streak = 0;
    const nextNonce = randomUuid();
    session.verify_nonce = nextNonce;
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: this.user?.id,
      subject_id: session.student_id,
      action: "unlock",
      metadata: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { sessionStatus: "active", nextNonce }, error: null };
  }

  private async _exemptFaceSession(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    if (this.profileRole !== "lecturer") return { data: { error: "not_lecturer" }, error: null };
    const session = (this.tables["quiz_sessions"] ?? []).find((s) => s.id === sessionId);
    if (!session) return { data: { error: "not_owner" }, error: null };
    if (session.status === "completed") return { data: { error: "session_not_active" }, error: null };
    session.face_exempt = true;
    session.status = "active";
    session.face_fail_streak = 0;
    const nextNonce = randomUuid();
    session.verify_nonce = nextNonce;
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: this.user?.id,
      subject_id: session.student_id,
      action: "exempt_face",
      metadata: { reason: args?.p_reason },
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { sessionStatus: "active", nextNonce }, error: null };
  }

  private async _reportFaceUnavailable(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    const studentId = this.user?.id ?? "";
    const session = (this.tables["quiz_sessions"] ?? []).find(
      (s) => s.id === sessionId && s.student_id === studentId,
    );
    if (!session) return { data: { error: "not_owner" }, error: null };
    if (session.mode !== "assessment") return { data: { error: "not_assessment" }, error: null };
    if (!session.face_unavailable_at) session.face_unavailable_at = "2026-01-01T00:00:00Z";
    return { data: { ok: true }, error: null };
  }

  /**
   * reset_session — lecturer deletes an assessment session (D2/D9, migration
   * 0011). Gated on ROLE + QUIZ OWNERSHIP (mirrors the `is_lecturer_of_quiz`
   * SQL helper — resolved via `quizzes.class_id → classes.lecturer_id`, NOT
   * `quiz.created_by`; the SQL gates on class ownership). On success it deletes
   * the row AND its session_answers/face_checks children (cascade), then
   * pushes the audit_events row INLINE (like the other RPC stubs — never the
   * test-only `seedAuditEvent` seam).
   */
  private async _resetSession(args?: Record<string, unknown>) {
    // House stub discipline: the seeded rpcResult seam overrides the stub so
    // the transport-error route test has an injection point.
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const sessionId = String(args?.p_session_id);
    if (this.profileRole !== "lecturer") return { data: { error: "not_lecturer" }, error: null };
    const session = (this.tables["quiz_sessions"] ?? []).find((s) => s.id === sessionId);
    if (!session) return { data: { error: "not_owner" }, error: null };
    // Ownership gate (mirror is_lecturer_of_quiz): the quiz's CLASS must be
    // owned by the caller — not the quiz's created_by column.
    const quiz = (this.tables["quizzes"] ?? []).find((q) => q.id === session.quiz_id);
    const cls = quiz ? (this.tables["classes"] ?? []).find((c) => c.id === quiz.class_id) : undefined;
    if (!quiz || !cls || cls.lecturer_id !== this.user?.id) {
      return { data: { error: "not_owner" }, error: null };
    }
    if (session.mode !== "assessment") {
      return { data: { error: "not_assessment" }, error: null };
    }

    const deleted: Row = { ...session };
    // Cascade delete the children then the session row itself.
    this.tables["session_answers"] = (this.tables["session_answers"] ?? []).filter(
      (a) => a.session_id !== sessionId,
    );
    this.tables["face_checks"] = (this.tables["face_checks"] ?? []).filter(
      (c) => c.session_id !== sessionId,
    );
    this.tables["quiz_sessions"] = (this.tables["quiz_sessions"] ?? []).filter(
      (s) => s.id !== sessionId,
    );

    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: this.user?.id,
      subject_id: session.student_id,
      action: "session_reset",
      metadata: { session_id: sessionId, quiz_id: session.quiz_id },
      created_at: "2026-01-01T00:00:00Z",
    });

    return {
      data: {
        ok: true,
        deleted_session_id: sessionId,
        student_id: deleted.student_id,
        quiz_id: deleted.quiz_id,
      },
      error: null,
    };
  }

  /** grant_face_consent — sets consent_given_at + audits (mirrors 0019). */
  private async _grantFaceConsent() {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const studentId = this.user?.id ?? "";
    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === studentId);
    if (!profile) return { data: { error: "not_student" }, error: null };
    profile.consent_given_at = "2026-01-01T00:00:00Z";
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: studentId,
      subject_id: studentId,
      action: "consent_granted",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { ok: true }, error: null };
  }

  private async _revokeFaceConsent() {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const studentId = this.user?.id ?? "";
    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === studentId);
    if (!profile) return { data: { error: "not_student" }, error: null };
    profile.consent_given_at = null;
    profile.face_enrollment_status = null;
    profile.face_deletion_pending = true;
    const flagged: Row[] = (this.tables["quiz_sessions"] ?? []).filter(
      (s) => s.student_id === studentId && s.mode === "assessment" && ["active", "paused"].includes(s.status as string),
    );
    for (const s of flagged) s.status = "flagged";
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: studentId,
      subject_id: studentId,
      action: "consent_revoked",
      metadata: { flagged_sessions: flagged.map((s) => s.id) },
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { ok: true, flagged_sessions: flagged.map((s) => s.id) }, error: null };
  }

  /** confirm_face_subject_deleted — clears face_deletion_pending for the caller. */
  private async _confirmFaceSubjectDeleted() {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    const studentId = this.user?.id ?? "";
    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === studentId);
    if (!profile) return { data: { error: "not_authenticated" }, error: null };
    profile.face_deletion_pending = false;
    return { data: { ok: true }, error: null };
  }

  /** reject_face_enrollment (lecturer-only) — clears a pending_review status. */
  private async _rejectFaceEnrollment(args?: Record<string, unknown>) {
    if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;
    if (this.profileRole !== "lecturer") return { data: { error: "not_lecturer" }, error: null };
    const studentId = String(args?.p_student_id ?? "");
    const profile = (this.tables["profiles"] ?? []).find((p) => p.id === studentId);
    if (!profile) return { data: { error: "not_owner" }, error: null };
    profile.face_enrollment_status = null;
    this.tables["audit_events"] ??= [];
    this.tables["audit_events"].push({
      id: randomUuid(),
      actor_id: this.user?.id,
      subject_id: studentId,
      action: "face_enroll_rejected",
      metadata: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    return { data: { ok: true }, error: null };
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
    opens_at: null,
    closes_at: null,
    allow_retake: false,
    max_attempts: 1,
    shuffle_questions: false,
    source_file_url: null,
    source_text: null,
    sources: [],
    created_at: "2026-01-01T00:00:00Z",
  });
  for (const q of opts?.questions ?? []) client.seedQuestion(q);

  return { client, ownerId, classId, quizId, questionId };
}
