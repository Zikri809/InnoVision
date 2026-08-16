/**
 * Ambient type declarations for the vendored MediaPipe URL import.
 *
 * `hand-tracker.ts` + `face-tracker.ts` dynamic-import `/mediapipe/vision_bundle.mjs`
 * at runtime (with a `/* webpackIgnore: true *​/` pragma so Next/Turbopack
 * leaves the URL untouched and the browser fetches the static file from
 * `public/`). This declaration gives TypeScript a typed surface for that
 * module so `typecheck` passes — the types mirror the exact-pinned
 * `@mediapipe/tasks-vision` package.
 */
declare module "/mediapipe/vision_bundle.mjs" {
  export const FilesetResolver: typeof import("@mediapipe/tasks-vision").FilesetResolver;
  export const HandLandmarker: typeof import("@mediapipe/tasks-vision").HandLandmarker;
  export const FaceLandmarker: typeof import("@mediapipe/tasks-vision").FaceLandmarker;
}
