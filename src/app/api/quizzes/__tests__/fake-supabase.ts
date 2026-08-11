/**
 * Minimal in-memory fake Supabase client for route-handler tests.
 *
 * Implements just enough of the fluent query-builder surface that the route
 * handlers + REAL guards (`requireUser`, `requireClassOwner`,
 * `requireQuizOwner`) use, backed by plain in-memory tables. This lets tests
 * exercise the actual authZ logic (I20: student → 403) and validation paths
 * without a live DB.
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
    const rows = this._execute();
    return { data: rows[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const rows = this._execute();
    if (rows.length === 0) return { data: null, error: { message: "PGRST116" } };
    return { data: rows[0], error: null };
  }

  /** Thenable so `await builder` works for count queries (publish route). */
  then(
    resolve: (value: { count?: number; data?: Row[]; error: null }) => void,
  ): void {
    const rows = this._execute();
    // Match PostgREST's real shape: count queries return { count, data, error },
    // plain queries return { data, error }.
    if (this.countExact) resolve({ count: rows.length, data: rows, error: null });
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

  private _execute(): Row[] {
    const tableRows = (this.client.tables[this.table] ??= []);

    if (!this.op) {
      return this._filtered(tableRows);
    }

    if (this.op.kind === "insert") {
      const r: Row = { ...this.op.row, id: this.op.row.id ?? randomUuid() };
      tableRows.push(r);
      return [r];
    }

    const op = this.op;
    const targets = this._filtered(tableRows);

    if (op.kind === "update") {
      targets.forEach((r) => Object.assign(r, op.row));
      return targets;
    }

    // delete
    this.client.tables[this.table] = tableRows.filter((r) => !targets.includes(r));
    return targets;
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

  auth = {
    getUser: async () => ({ data: { user: this.user } }),
  };

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }

  // rpc() models the RPCs the routes call:
  //  - append_question: appends with order_index = max+1.
  //  - replace_quiz_questions: atomic replace (delete + insert + quiz update).
  //  - reorder_questions / others: return the pre-seeded rpcResult.
  async rpc(name: string, args?: Record<string, unknown>) {
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
