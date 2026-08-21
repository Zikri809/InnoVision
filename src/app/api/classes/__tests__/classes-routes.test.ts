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
  const joinRoute = await import("@/app/api/classes/join/route");
  return { classesRoute, classDetailRoute, joinRoute };
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

const LECTURER_ID = "00000000-0000-4000-8000-0000000000aa";

function lecturerContext() {
  const client = new FakeSupabase();
  client.setUser(LECTURER_ID, "lecturer");
  fakeHolder.current = client;
  return client;
}

beforeEach(() => {
  vi.resetModules();
  fakeHolder.current = undefined;
});

describe("GET /api/classes — auth & filtering", () => {
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
    client.tables["student_class_view"] = [
      { id: CLASS_B, title: "Physics", created_at: "2026-01-01T00:00:00Z" },
    ];

    const { classesRoute } = await importHandlers();
    const res = await classesRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classes).toHaveLength(1);
    expect(body.classes[0].title).toBe("Physics");
    expect("join_code" in body.classes[0]).toBe(false);
  });

  it("lecturer GET → 200 with classes including archived_at", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classesRoute } = await importHandlers();
    const res = await classesRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classes).toHaveLength(1);
    expect(body.classes[0].title).toBe("Physics");
    expect(body.classes[0].archived_at).toBe(null);
  });
});

describe("GET /api/classes/[id] — auth & projection", () => {
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
    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(404);
  });

  it("lecturer GET → 200 with full detail and roster", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];
    client.tables["student_roster_view"] = [];

    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.title).toBe("Physics");
    expect(body.class.join_code).toBe("ABCDEF");
    expect(body.roster).toEqual([]);
  });

  it("non-owner lecturer GET → 404 (no oracle)", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: "00000000-0000-4000-8000-000000000099",
        title: "Other's Class",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH & DELETE /api/classes/[id] — archiving & soft delete", () => {
  it("lecturer can update class title via PATCH { title }", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Old Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Advanced Physics" }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.title).toBe("Advanced Physics");
    expect(body.class.archived_at).toBe(null);
  });

  it("lecturer can archive class via PATCH { archived: true }", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ archived: true }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.archived_at).toBeTruthy();
  });

  it("lecturer can restore class via PATCH { archived: false }", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: "2026-01-02T00:00:00Z",
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ archived: false }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.archived_at).toBe(null);
  });

  it("PATCH rejects empty update payload with 400 empty_update", async () => {
    lecturerContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({}),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("empty_update");
  });

  it("PATCH rejects invalid title length with 400 invalid_title", async () => {
    lecturerContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "   " }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_title");
  });

  it("PATCH rejects non-boolean archived field with 400 invalid_archived", async () => {
    lecturerContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ archived: "true" }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_archived");
  });

  it("non-owner lecturer PATCH returns 404 (no oracle)", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: "00000000-0000-4000-8000-000000000099",
        title: "Other's Class",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ archived: true }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(404);
  });

  it("student caller PATCH returns 403 forbidden", async () => {
    studentContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ archived: true }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(403);
  });

  it("cross-origin PATCH returns 403 invalid_origin", async () => {
    lecturerContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://attacker.com" },
      body: JSON.stringify({ archived: true }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(403);
  });

  it("lecturer soft-deletes class via DELETE (sets archived_at)", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "DELETE",
      headers: { origin: "http://localhost" },
    });

    const res = await classDetailRoute.DELETE(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(true);
  });

  it("non-owner lecturer DELETE returns 404", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: "00000000-0000-4000-8000-000000000099",
        title: "Other's Class",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "DELETE",
      headers: { origin: "http://localhost" },
    });

    const res = await classDetailRoute.DELETE(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(404);
  });

  it("student caller DELETE returns 403", async () => {
    studentContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "DELETE",
      headers: { origin: "http://localhost" },
    });

    const res = await classDetailRoute.DELETE(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(403);
  });

  it("cross-origin DELETE returns 403 invalid_origin", async () => {
    lecturerContext();
    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "DELETE",
      headers: { origin: "http://attacker.com" },
    });

    const res = await classDetailRoute.DELETE(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(403);
  });
});

describe("I-C5 & Dispute Audit — GET /api/classes/[id] on archived classes", () => {
  it("I-C5: student GET for an archived enrolled class → 404 (hidden via student_class_view)", async () => {
    const client = studentContext();
    // student_class_view excludes archived classes at DB level, so view has 0 rows
    client.tables["student_class_view"] = [];

    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(404);
  });

  it("lecturer GET on archived class → 200 with archived_at and full roster for dispute audit", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Archived Physics",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: "2026-01-10T12:00:00Z",
      },
    ];
    client.tables["student_roster_view"] = [
      { class_id: CLASS_B, student_id: "00000000-0000-4000-8000-0000000000ff", full_name: "Student One", enrolled_at: "2026-01-02T00:00:00Z" },
    ];

    const { classDetailRoute } = await importHandlers();
    const res = await classDetailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.archived_at).toBe("2026-01-10T12:00:00Z");
    expect(body.roster).toHaveLength(1);
    expect(body.roster[0].full_name).toBe("Student One");
  });
});

describe("I-C6 — POST /api/classes/join on archived classes", () => {
  it("I-C6: student join attempt on archived class → 400 class_archived", async () => {
    const client = studentContext();
    client.rpcResult = { data: { error: "class_archived" }, error: null };

    const { joinRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/join", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ code: "ABCDEF" }),
    });

    const res = await joinRoute.POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("class_archived");
  });
});

describe("PATCH /api/classes/[id] — combined mutations", () => {
  it("lecturer can update title and unarchive simultaneously", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: CLASS_B,
        lecturer_id: LECTURER_ID,
        title: "Old Archived Class",
        join_code: "ABCDEF",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: "2026-01-10T00:00:00Z",
      },
    ];

    const { classDetailRoute } = await importHandlers();
    const req = new Request("http://localhost/api/classes/" + CLASS_B, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Restored & Renamed Class", archived: false }),
    });

    const res = await classDetailRoute.PATCH(req, {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.class.title).toBe("Restored & Renamed Class");
    expect(body.class.archived_at).toBe(null);
  });
});


