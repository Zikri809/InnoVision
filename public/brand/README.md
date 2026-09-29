# Easy2U brand assets

The ribbon mark comes from the team's `logo general.svg`, supplied on
2026-09-27. Its silhouette, proportions and colours are preserved.

The supplied SVG exports contain embedded bitmap images rather than vector
outlines. The original image and its opacity mask were extracted together,
with the export backgrounds removed and the viewBox tightened. No tracing,
recolouring or redesign was applied.

- `easy2u-mark.webp`: transparent 960px-wide mark for the UI (about 43 KB).
- `easy2u-mark.png`: transparent 512px-wide mark for the server-rendered share
  image and app icons, without a network fetch.
- `../icon.svg` and `../icon-maskable.svg`: the mark embedded in a brown tile;
  the maskable variant keeps the artwork inside the central safe area.
- `../apple-touch-icon.png` and `src/app/favicon.ico`: raster app/browser icons.

`src/components/brand-logo.tsx` pairs the mark with the app's Fredoka wordmark
and a theme-aware clay tile (white card in light mode, warm brown in dark
mode) so the frame never looks like the wrong theme. Keep the mark unrotated
and preserve its aspect ratio.

The static share card is `src/app/opengraph-image.png`. Regenerate it with
`node scripts/generate-brand-share-image.mjs`; this uses the bundled font and
local PNG, so the deployed app needs no renderer or font download for it.

For future print use or a crisper tiny favicon, request a true vector master
from the team. Renaming a bitmap export to SVG does not make it a vector.
