import { describe, expect, it, vi } from "vitest";
import { removeStorageObjects, removeValidatedStoragePrefix } from "./cleanup";

/**
 * audit-3 C-F1/G-F3/H3-INFRA-F9: the sweep helper must (a) await the call,
 * (b) log a rejection instead of swallowing it, and (c) only hand validated
 * paths to the service-role remove().
 */

type AdminLike = Parameters<typeof removeStorageObjects>[0];

function adminWith(impl: {
  remove?: (paths: string[]) => Promise<{ error: { message: string } | null }>;
  list?: (prefix: string) => Promise<{ data: { name: string }[] | null; error: { message: string } | null }>;
}) {
  const removed: Record<string, string[][]> = {};
  const admin = {
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed[bucket] ??= [];
          removed[bucket].push(paths);
          return impl.remove ? impl.remove(paths) : { error: null };
        },
        list: async (prefix: string) =>
          impl.list ? impl.list(prefix) : { data: [], error: null },
      }),
    },
  } as unknown as AdminLike;
  return { admin, removed };
}

describe("removeStorageObjects", () => {
  it("awaits remove() with the exact path list", async () => {
    const { admin, removed } = adminWith({});
    await removeStorageObjects(admin, "quiz-sources", ["a/b/c.pdf"]);
    expect(removed["quiz-sources"]).toEqual([["a/b/c.pdf"]]);
  });

  it("no-ops on an empty list (never calls storage)", async () => {
    const { admin, removed } = adminWith({});
    await removeStorageObjects(admin, "quiz-sources", []);
    expect(removed["quiz-sources"]).toBeUndefined();
  });

  it("LOGS a storage error instead of swallowing it (H3-INFRA-F9)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = adminWith({ remove: async () => ({ error: { message: "storage 503" } }) });
    await removeStorageObjects(admin, "question-images", ["u/1.png"]);
    expect(spy).toHaveBeenCalledWith(
      "storage cleanup failed",
      expect.objectContaining({ bucket: "question-images", count: 1, error: "storage 503" }),
    );
    spy.mockRestore();
  });

  it("LOGS a thrown rejection instead of letting it escape", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = adminWith({
      remove: async () => {
        throw new Error("network down");
      },
    });
    await expect(removeStorageObjects(admin, "quiz-sources", ["a/b/c.pdf"])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      "storage cleanup threw",
      expect.objectContaining({ bucket: "quiz-sources", error: "network down" }),
    );
    spy.mockRestore();
  });
});

describe("removeValidatedStoragePrefix", () => {
  it("lists the prefix, validates every object, and removes the accepted ones", async () => {
    const { admin, removed } = adminWith({
      list: async () => ({
        data: [{ name: "uuid-notes.pdf" }, { name: "../../escape.pdf" }],
        error: null,
      }),
    });
    const validate = (p: string) => !p.includes("..");
    await removeValidatedStoragePrefix(admin, "quiz-sources", "uid/quiz", validate);
    expect(removed["quiz-sources"]).toEqual([["uid/quiz/uuid-notes.pdf"]]);
  });

  it("logs and stops when list() errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin, removed } = adminWith({
      list: async () => ({ data: null, error: { message: "list failed" } }),
    });
    await removeValidatedStoragePrefix(admin, "quiz-sources", "uid/quiz", () => true);
    expect(removed["quiz-sources"]).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      "storage prefix sweep failed",
      expect.objectContaining({ bucket: "quiz-sources", prefix: "uid/quiz" }),
    );
    spy.mockRestore();
  });
});
