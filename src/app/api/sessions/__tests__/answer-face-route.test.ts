import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import * as answerRoute from "@/app/api/sessions/[id]/answer/route";
import { mintAnswerProof, mintVerifyProof } from "@/lib/face/server/verify-proof";

const mock = vi.hoisted(() => ({
  client: undefined as FakeSupabase | undefined,
  extractFace: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mock.client }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string) => name === "get_verify_proof_secret"
      ? Promise.resolve({ data: "route-test-secret", error: null })
      : Promise.resolve({ data: null, error: { message: "unexpected admin rpc" } }),
  }),
}));
vi.mock("@/lib/face/server/insightface-client", () => ({
  extractFace: (...args: unknown[]) => mock.extractFace(...args),
}));

const QUIZ_ID = "00000000-0000-4000-8000-00000000000c";
const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const QUESTION_ID = "00000000-0000-4000-8000-00000000000d";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";

function request(body: unknown) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quiz = ctx.client.tables.quizzes![0];
  quiz.mode = "assessment";
  quiz.gestures_enabled = true;
  ctx.client.setUser(STUDENT_ID, "student");
  ctx.client.seedQuestion({
    id: QUESTION_ID,
    quiz_id: QUIZ_ID,
    order_index: 0,
    type: "mcq",
    prompt: "Question",
    options: ["a", "b"],
    correct_index: 0,
  });
  ctx.client.seedSession({
    id: SESSION_ID,
    quiz_id: QUIZ_ID,
    student_id: STUDENT_ID,
    mode: "assessment",
    status: "active",
    verify_nonce: "11111111-1111-4111-8111-111111111111",
  });
  mock.client = ctx.client;
  return ctx.client;
}

function verifiedFrames(client: FakeSupabase, result: unknown) {
  const embedding = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
  client.tables.profile_face_samples = [{ profile_id: STUDENT_ID, embedding }];
  client.rpcResult = { data: result, error: null };
  mock.extractFace.mockResolvedValue({
    faces: [{ embedding, yaw: 0, pitch: 0, roll: 0, det_score: 0.99, bbox: [10, 10, 200, 200] }],
  });
  return {
    questionId: QUESTION_ID,
    selectedIndex: 1,
    faceVerification: {
      nonce: "11111111-1111-4111-8111-111111111111",
      frames: ["ZmFrZTE=", "ZmFrZTI=", "ZmFrZTM="],
    },
  };
}

beforeEach(() => {
  mock.client = undefined;
  mock.extractFace.mockReset();
  _resetRateLimiter();
});

describe("answer face verification failures", () => {
  it("holds on inference outage before calling the answer commit", async () => {
    const client = context();
    mock.extractFace.mockRejectedValue(new Error("sidecar unavailable"));
    const res = await answerRoute.POST(request({
      questionId: QUESTION_ID,
      selectedIndex: 1,
      faceVerification: {
        nonce: "11111111-1111-4111-8111-111111111111",
        frames: ["ZmFrZTE=", "ZmFrZTI=", "ZmFrZTM="],
      },
    }), { params: Promise.resolve({ id: SESSION_ID }) });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("verification_unavailable");
    expect(client.rpcCalls.some((call) => call.name === "commit_answer")).toBe(false);
    expect(client.tables.session_answers ?? []).toHaveLength(0);
  });

  it("sends fresh frames and proofs bound to the exact answer, then adopts the face check", async () => {
    const client = context();
    const faceCheck = {
      matched: true,
      sessionStatus: "active",
      nextNonce: "22222222-2222-4222-8222-222222222222",
    };
    const body = verifiedFrames(client, { recorded: true, faceCheck });
    const res = await answerRoute.POST(request(body), { params: Promise.resolve({ id: SESSION_ID }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, faceCheck });
    const call = client.rpcCalls.find((entry) => entry.name === "commit_answer")!;
    expect(call.args?.p_frames).toEqual(body.faceVerification.frames);
    expect(call.args?.p_question_id).toBe(QUESTION_ID);
    expect(call.args?.p_selected_index).toBe(1);
    expect(call.args?.p_proof).toBe(mintVerifyProof(
      "route-test-secret", SESSION_ID, body.faceVerification.nonce, body.faceVerification.frames,
    ));
    expect(call.args?.p_answer_proof).toBe(mintAnswerProof(
      "route-test-secret", SESSION_ID, body.faceVerification.nonce, body.faceVerification.frames,
      { questionId: QUESTION_ID, selectedIndex: 1 },
    ));
  });

  it("returns the committed mismatch status without saving the answer", async () => {
    const client = context();
    const faceCheck = {
      matched: false,
      sessionStatus: "paused",
      nextNonce: "22222222-2222-4222-8222-222222222222",
    };
    const body = verifiedFrames(client, { error: "face_mismatch", faceCheck });
    const res = await answerRoute.POST(request(body), { params: Promise.resolve({ id: SESSION_ID }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "face_mismatch", faceCheck });
    expect(client.tables.session_answers ?? []).toHaveLength(0);
    expect(client.rpcCalls.some((call) => call.name === "commit_answer")).toBe(true);
  });
});
