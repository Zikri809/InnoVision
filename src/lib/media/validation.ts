/**
 * Shared media-upload validation for question images + avatars.
 *
 * House rule: the client is never trusted. Every byte that reaches storage
 * passes through here first:
 *  - magic-byte sniffing decides the ACTUAL type/ext/content-type (the
 *    client-declared MIME is advisory only — a mislabeled payload would be
 *    stored and served under the wrong type). The byte cap itself is enforced
 *    by `readCappedFormData` in `media/server.ts` (streaming, header-agnostic);
 *    the pre-H-04 header-only `checkMultipartLength` gate was dead code and
 *    has been removed;
 *  - stored-path format validators run immediately before every signed-URL
 *    mint or service-role storage operation, so a tampered DB column can never
 *    steer the signer/remover outside the owner's folder (traversal/`..`
 *    cannot match the anchored regexes).
 */

export const MAX_QUESTION_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Slack over the file cap for multipart framing (boundaries, filename). */
export const MULTIPART_FRAMING_SLACK_BYTES = 64 * 1024;

export const QUESTION_IMAGES_BUCKET = "question-images";
export const AVATARS_BUCKET = "avatars";
export const QUIZ_SOURCES_BUCKET = "quiz-sources";

export type SniffedImageType = "png" | "jpeg" | "webp";

const EXT_BY_TYPE: Record<SniffedImageType, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

const CONTENT_TYPE_BY_TYPE: Record<SniffedImageType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Magic-byte sniff for the three accepted raster formats:
 *  - PNG:  89 50 4E 47 0D 0A 1A 0A
 *  - JPEG: FF D8 FF
 *  - WebP: "RIFF" at 0..3 + "WEBP" at 8..11
 * Truncated headers (buffer shorter than the signature) do not match.
 */
export function sniffImageType(buffer: Buffer): SniffedImageType | null {
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e &&
      buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a &&
      buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return "png";
  }
  if (buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export function extFor(type: SniffedImageType): string {
  return EXT_BY_TYPE[type];
}

export function contentTypeFor(type: SniffedImageType): string {
  return CONTENT_TYPE_BY_TYPE[type];
}

// ─── Stored-path validators (defense in depth before signing) ────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMG_EXT_RE = /^\.(png|jpe?g|webp)$/;

/**
 * Avatar object path contract: `<ownerUid>/avatar.<img-ext>`. Single current
 * object per user; extension follows the LAST successful upload's sniff.
 */
export function isValidAvatarPath(path: string, ownerUid: string): boolean {
  if (!path.startsWith(`${ownerUid}/`)) return false;
  const rest = path.slice(ownerUid.length + 1);
  const dot = rest.indexOf(".");
  if (dot <= 0) return false;
  return rest.slice(0, dot) === "avatar" && IMG_EXT_RE.test(rest.slice(dot));
}

const ANY_UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner-AGNOSTIC question-image path shape for the signing route: the caller
 * is usually NOT the owner (students view lecturer material), so the owner
 * prefix cannot be pinned to auth.uid() — but it must still be exactly two
 * segments: a UUID owner folder and one UUID-named image file. Anchored, so
 * traversal or extra segments cannot reach the signer.
 */
export function isWellFormedQuestionImagePath(path: string): boolean {
  const slash = path.indexOf("/");
  if (slash <= 0 || path.indexOf("/", slash + 1) !== -1) return false;
  const owner = path.slice(0, slash);
  const rest = path.slice(slash + 1);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return false;
  return ANY_UID_RE.test(owner) && UUID_RE.test(rest.slice(0, dot)) && IMG_EXT_RE.test(rest.slice(dot));
}

/**
 * audit-2 C-03: OWNER-PINNED gate for every PRIVILEGED storage operation
 * (service-role remove()/copy()) fed from a DB column. The signing route
 * only needs isWellFormedQuestionImagePath (the viewer is not the owner);
 * delete/replace/copy DO know the owner, so the folder prefix must be pinned
 * to them — a tampered/poisoned column pointing at another user's object
 * (or any stray path) fails closed here instead of deleting cross-tenant
 * bytes through the confused deputy. Callers skip+log on false, never throw.
 */
export function isOwnedQuestionImagePath(path: string, ownerUid: string): boolean {
  return (
    path.startsWith(`${ownerUid}/`) && isWellFormedQuestionImagePath(path)
  );
}

/**
 * audit-3 C-F1: `quiz-sources` object path contract. Uploads are constructed
 * client-side (UploadDropzone) as
 * `<ownerUid>/<quizId>/<client-uuidv4>-<sanitized-filename>` — exactly three
 * segments, both folders UUIDs, the file name a UUID followed by `-<rest>`.
 * Anchored, so traversal, extra segments, and empty segments cannot match.
 *
 * The quiz DELETE sweep feeds DB columns (`source_file_url`, `sources[].storage_path`)
 * to a service-role `remove()`; those columns are caller-writable at the DB
 * layer, so an unvalidated path would let a lecturer destroy another tenant's
 * object. There was no `quiz-sources` validator before this one — the C-03
 * owner-pin gate had only ever been applied to the question-images bucket.
 */
const QUIZ_SOURCE_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$/i;

export function isWellFormedQuizSourcePath(path: string): boolean {
  const parts = path.split("/");
  if (parts.length !== 3) return false;
  const [owner, quizId, file] = parts;
  return (
    ANY_UID_RE.test(owner) &&
    UUID_RE.test(quizId) &&
    QUIZ_SOURCE_FILE_RE.test(file)
  );
}

/**
 * OWNER-PINNED gate for privileged `quiz-sources` operations fed from a DB
 * column (the quiz DELETE sweep). Mirrors isOwnedQuestionImagePath: the
 * first segment must be the acting owner's uid AND the whole path must match
 * the well-formed contract. Callers skip + log on false, never throw.
 */
export function isOwnedQuizSourcePath(path: string, ownerUid: string): boolean {
  return path.startsWith(`${ownerUid}/`) && isWellFormedQuizSourcePath(path);
}
