import { describe, it, expect } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { StudentFakeSupabase } from "@/app/api/student-quizzes/__tests__/fake-student-supabase";

/**
 * H3-INFRA-F4: the fake must never answer an RPC it does not model with a
 * success-shaped default — that is how a renamed/removed RPC let route tests
 * stay green (the E-F1 drift class). Known-but-unmodeled names are listed in
 * SEAM_ONLY_RPCS (their semantics are pinned by the verify-*.mjs harnesses);
 * everything else throws.
 */
describe("FakeSupabase.rpc — unknown RPC guard", () => {
  it("throws a descriptive error for an unmodeled RPC name", async () => {
    const client = new FakeSupabase();
    await expect(client.rpc("no_such_rpc_anywhere")).rejects.toThrow(
      /FakeSupabase\.rpc\("no_such_rpc_anywhere"\) is not modeled/,
    );
  });

  it("still answers the known seam-only names through rpcResult", async () => {
    const client = new FakeSupabase();
    client.rpcResult = { data: { class: { id: "c1" } }, error: null };
    await expect(client.rpc("join_class", { code: "ABCDEF" })).resolves.toEqual({
      data: { class: { id: "c1" } },
      error: null,
    });
  });

  it("StudentFakeSupabase still routes its own modeled RPCs", async () => {
    const client = new StudentFakeSupabase();
    client.setUser("00000000-0000-4000-8000-0000000000a1", "student");
    // reorder with a mismatched id count → the modeled error key, not a throw.
    await expect(client.rpc("reorder_student_questions", { p_quiz_id: "q1", p_ordered_ids: [] })).resolves.toEqual({
      data: null,
      error: { message: "not_owner" },
    });
  });
});
