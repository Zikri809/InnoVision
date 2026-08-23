import { describe, expect, it } from "vitest";
import { resolveNotificationLink } from "../link";
import { NOTIFICATION_TYPES } from "../types";

describe("resolveNotificationLink", () => {
  const payload = {
    quiz_id: "q-1",
    quiz_title: "T",
    class_id: "c-1",
    class_title: "C",
  };

  it("student list targets never probe", () => {
    for (const type of ["quiz_live", "session_reset"] as const) {
      expect(resolveNotificationLink(type, payload)).toEqual({ href: "/student/quizzes" });
    }
    expect(resolveNotificationLink("removed_from_class", payload)).toEqual({
      href: "/student/classes",
    });
    expect(resolveNotificationLink("class_archived", payload)).toEqual({
      href: "/student/classes",
    });
  });

  it("results_revealed requests session resolution", () => {
    const link = resolveNotificationLink("results_revealed", payload);
    expect(link.href).toBe("/student/quizzes");
    expect(link.resolveSessionQuizId).toBe("q-1");
  });

  it("lecturer quiz links target the results dashboard and probe the quiz", () => {
    for (const type of [
      "session_submitted",
      "session_flagged",
      "quiz_completed_all",
      "incident_clip_recorded",
      "face_unavailable_reported",
    ] as const) {
      const link = resolveNotificationLink(type, payload);
      expect(link.href).toBe("/lecturer/quizzes/q-1/results");
      expect(link.probe).toEqual({ table: "quizzes", id: "q-1" });
    }
  });

  it("student_joined links to its class; held enrollment to the roster list", () => {
    expect(resolveNotificationLink("student_joined", payload)).toEqual({
      href: "/lecturer/classes/c-1",
    });
    expect(resolveNotificationLink("face_enrollment_held", {})).toEqual({
      href: "/lecturer/classes",
    });
  });

  it("every notification type resolves to some link (exhaustiveness)", () => {
    for (const type of NOTIFICATION_TYPES) {
      const link = resolveNotificationLink(type, payload);
      expect(link.href.startsWith("/")).toBe(true);
    }
  });
});
