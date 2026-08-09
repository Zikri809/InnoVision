import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "../../quizzes/__tests__/fake-supabase";

// The class routes import createClient from "@/lib/supabase/server". Mock it
// to return our fake so the REAL guards + handlers run against in-memory data.
const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

async function importHandlers() {
  const classesRoute = await import("@/app/api/classes/route");
  const classDetailRoute = await import("@/app/api/classes/[id]/route");
  return { classesRoute, classDetailRoute };
}

const CLASS_B = "00000000-0000-4000-8000-00000000000b";

function anonymousContext() {
  const client = new FakeSupabase();
  // No user set → getUser() returns { user: null } → the route returns 401.
  fakeHolder.current = client;
  return client;
}

function studentContext() {
  const client = new FakeSupabase();
  client.setUser("00000000-0000-4000-8000-0000000000ff", "student");
  fakeHolder.current = client;
  return client;
}

beforeEach(() => {
  vi.resetModules();
  fakeHolder.current = undefined;
});

describe("GET /api/classes — auth", () => {
  it("anonymous GET → 401 (never HTML/redirect)", async () => {
    anonymousContext();
    const { classesRoute } = await importHandlers();
    const res = await classesRoute.GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("student GET → 200 with classes from the join-code-free view", async () => {
    const client = studentContext();
    // The student reads student_class_view; seed it directly (the fake does
    // not model view internals, so we seed the projected rows).
    client.tables["student_class_view"] = [
      { id: CLASS_B, title: "Physics", created_at: "2026-01-01T00:00:00Z" },
    ];

    const { classesRoute } = await importHandlers();
    const res = await classesRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classes).toHaveLength(1);
    expect(body.classes[0].title).toBe("Physics");
    // The view projection never includes join_code.
    expect("join_code" in body.classes[0]).toBe(false);
  });
});

describe("GET /api/classes/[id] — auth", () => {
  it("anonymous GET → 401", async () => {
    anonymousContext();
    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(401);
  });

  it("non-UUID id → 404 before any auth", async () => {
    anonymousContext();
    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
  });

  it("student GET → 200 with title only (no join_code/roster)", async () => {
    const client = studentContext();
    client.tables["student_class_view"] = [
      { id: CLASS_B, title: "Physics", created_at: "2026-01-01T00:00:00Z" },
    ];

    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.title).toBe("Physics");
    expect("join_code" in body.class).toBe(false);
    expect("roster" in body).toBe(false);
  });

  it("student GET for an unenrolled class → 404 (no oracle)", async () => {
    studentContext();
    // student_class_view is empty → maybeSingle returns null → 404.
    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(404);
  });
});
