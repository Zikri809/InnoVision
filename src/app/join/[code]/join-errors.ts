/**
 * Pure mapping from the /api/classes/join error surface to `join.*` message
 * key names. Kept free of React/next-intl so the table is unit-testable
 * (the drawer's raw-English precedent shows error mappings rot silently).
 *
 * "generic" means common.errorGeneric — reserved for transport/CSRF/auth
 * states where no join-specific copy would be honest.
 */
export type JoinErrorKey =
  | "invalidCode"
  | "alreadyEnrolled"
  | "classArchived"
  | "joinLocked"
  | "rateLimited"
  | "forbidden"
  | "generic";

export function joinErrorKey(status: number, apiError: string | undefined): JoinErrorKey {
  switch (apiError) {
    case "invalid_code":
      return "invalidCode";
    case "already_enrolled":
      return "alreadyEnrolled";
    case "join_locked":
      return "joinLocked";
    case "rate_limited":
      return "rateLimited";
    case "forbidden":
      return "forbidden";
    // NOTE (audit-2): "class_archived" no longer exists on the wire (M-04:
    // folded to 404 invalid_code — no existence oracle) and "matric_required"
    // is intercepted by the island (router.replace to /matric-capture, H-11)
    // before this mapper runs. Neither case belongs here.
    // Session died between render and click (requireStudent 401) or the
    // CSRF origin check tripped — join-specific copy would lie here.
    case "unauthorized":
    case "invalid_origin":
    case "invalid_json":
    case "internal":
      return "generic";
    default:
      // Unknown typed error or missing body — fold by status family so the
      // copy never invents a failure reason.
      if (status >= 500) return "generic";
      if (status === 401 || status === 403) return "generic";
      return "invalidCode";
  }
}
