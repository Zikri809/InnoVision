import { ImageResponse } from "next/og";

export const alt =
  "Easy2U — AI-powered gesture quizzes with face verification";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// TODO(brand): the "IV" tile is the same placeholder mark as public/icon.svg.
// When the real logo lands, swap the tile for it here (and in icons/manifest).
// Deliberately rendered with satori's bundled default font — the prod container
// only allows outbound 443 to Supabase/Z.ai/TinyFish/AI_BASE_URL
// (docs/DEPLOY_VPS.md), so a Google-Fonts fetch would fail the OG route.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 64,
          background: "#f97316",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 230,
            height: 230,
            borderRadius: 52,
            background: "#fff7ed",
            alignItems: "center",
            justifyContent: "center",
            // Clay offset shadow — warm brown, never gray/black.
            boxShadow: "16px 16px 0 #431407",
          }}
        >
          <div style={{ fontSize: 130, fontWeight: 700, color: "#431407" }}>
            E2
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 112, fontWeight: 700, color: "#431407" }}>
            Easy2U
          </div>
          <div style={{ fontSize: 36, color: "#7c2d12" }}>
            AI-powered gesture quizzes with face verification
          </div>
        </div>
      </div>
    ),
    size,
  );
}
