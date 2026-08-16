# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** InnoVision
**Generated:** 2026-08-16 11:46:16
**Category:** EdTech / AI Quiz & Assessment Platform (gesture-answered, face-verified)
**Approved Direction:** Option 3 — Playful / Student-Friendly (Claymorphism)
**Reference Mockup:** `redesign-previews/option-3-playful.html` (source of truth for the clay look)
**Design Dials:** Variance 7/10 (Balanced / Modern) | Motion 7/10 (Standard) | Density 4/10 (Standard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#F97316` | `--color-primary` |
| On Primary | `#0F172A` | `--color-on-primary` |
| Secondary | `#FB923C` | `--color-secondary` |
| On Secondary | `#0F172A` | `--color-on-secondary` |
| Accent/CTA | `#2563EB` | `--color-accent` |
| On Accent/CTA | `#FFFFFF` | `--color-on-accent` |
| Background | `#FFF7ED` | `--color-background` |
| Foreground | `#9A3412` | `--color-foreground` |
| Card | `#FFFFFF` | `--color-card` |
| Card Foreground | `#9A3412` | `--color-card-foreground` |
| Muted | `#F1F0F0` | `--color-muted` |
| Muted Foreground | `#475569` | `--color-muted-foreground` |
| Border | `#FED7AA` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| On Destructive | `#FFFFFF` | `--color-on-destructive` |
| Ring | `#000000` | `--color-ring` |

**Color Notes:** Playful orange + trust blue

### Typography

- **Heading Font:** Fredoka (weights 500-600; `letter-spacing: -0.01em`)
- **Body Font:** Nunito (weights 600-800 for UI text; this is a high-weight, friendly system)
- **Mood:** playful, friendly, fun, creative, warm, approachable
- **Google Fonts:** [Fredoka + Nunito](https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700;800&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap');
```

**Type Scale & Weights (this system runs bold — body text is 600-700, not 400):**

| Element | Font | Size | Weight | Notes |
|---------|------|------|--------|-------|
| Display / H1 | Fredoka | `clamp(38px,6.4vw,68px)` | 600 | `line-height:1.05` |
| H2 (section) | Fredoka | `clamp(30px,4.4vw,44px)` | 600 | |
| H3 (card) | Fredoka | `20px` | 600 | |
| Lead / sub | Nunito | `19px` | 600 | muted-fg color |
| Body / card text | Nunito | `15-16px` | 600-700 | muted-fg color |
| Button / label | Nunito | `15-16px` | 800 | |
| Small / eyebrow | Nunito | `13-14px` | 800 | often uppercase on pills |

### Spacing Variables

*Density: 4/10 — Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Border Radius (chunky — never flat)

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `12px` | Small chips, key caps, toggles |
| `--radius-md` | `16px` | Buttons, inputs, small cards |
| `--radius-lg` | `22px` | Cards, feature tiles (default) |
| `--radius-xl` | `28px` | Hero mockups, large containers |
| `--radius-pill` | `999px` | Pills, badges, progress dots |

### Shadow Depths (clay = hard offset + optional inner highlight)

Clay uses **hard offset shadows** (no blur) for the toy-like 3D press, plus a subtle **inner highlight/shade** for the "puffy" volume. Avoid soft blurred drop-shadows on interactive clay elements.

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-clay` | `6px 6px 0 rgba(194,65,12,.14)` | Default clay card (orange-tinted) |
| `--shadow-clay-accent` | `6px 6px 0 rgba(29,78,216,.14)` | Blue-tinted clay (CTA panels) |
| `--shadow-clay-in` | `inset 0 -4px 0 rgba(194,65,12,.1), inset 0 3px 0 rgba(255,255,255,.8)` | Inner volume for hero/containers |
| `--shadow-btn-primary` | `0 5px 0 #c2410c` | Orange button "3D base" |
| `--shadow-btn-accent` | `0 5px 0 #1d4fd7` | Blue button "3D base" |
| `--shadow-sm` | `0 4px 0 var(--color-border)` | Small clay elements (options, chips) |

---

## Component Specs

### Buttons (clay — 3D base + soft-press)

All buttons have a **solid "3D base" shadow** under them. On `:hover` they lift (base grows), on `:active` they **press down** (base collapses). This tactile press is the signature clay interaction.

```css
/* Base clay button */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 14px 28px; border-radius: 18px;
  font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 16px;
  border: 3px solid transparent; cursor: pointer;
  transition: transform 180ms ease, box-shadow 180ms ease;
}
.btn:active { transform: translateY(3px); }  /* soft-press: base collapses */
.btn:focus-visible { outline: 3px solid #2563EB; outline-offset: 3px; }

/* Primary (orange) */
.btn-primary { background: #F97316; color: #fff; box-shadow: 0 5px 0 #c2410c; }
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 7px 0 #c2410c; }
.btn-primary:active { box-shadow: 0 2px 0 #c2410c; }

/* Accent / CTA (blue) */
.btn-accent { background: #2563EB; color: #fff; box-shadow: 0 5px 0 #1d4fd7; }
.btn-accent:hover { transform: translateY(-2px); box-shadow: 0 7px 0 #1d4fd7; }
.btn-accent:active { box-shadow: 0 2px 0 #1d4fd7; }

/* Ghost (white with chunky border) */
.btn-ghost { background: #fff; color: #9A3412; border: 3px solid #FED7AA; box-shadow: 0 5px 0 #FED7AA; }
.btn-ghost:hover { transform: translateY(-2px); box-shadow: 0 7px 0 #FED7AA; }
.btn-ghost:active { box-shadow: 0 2px 0 #FED7AA; }
```

### Cards (clay — thick border + offset shadow)

```css
.card {
  background: #FFFFFF;
  border: 3px solid #FED7AA;
  border-radius: 22px;
  padding: 30px;
  box-shadow: 6px 6px 0 rgba(194,65,12,.14);
  transition: transform 200ms ease, box-shadow 200ms ease;
}
.card:hover {
  transform: translateY(-5px) rotate(-0.5deg);   /* playful tilt on hover */
  box-shadow: 8px 10px 0 rgba(194,65,12,.16);
}
/* Large hero/container variant adds inner volume: */
.card-hero { box-shadow: 6px 6px 0 rgba(194,65,12,.14), inset 0 -4px 0 rgba(194,65,12,.1), inset 0 3px 0 rgba(255,255,255,.8); }
```

### Inputs (clay — chunky, colored focus ring)

```css
.input {
  padding: 14px 18px;
  background: #FFFFFF;
  border: 3px solid #FED7AA;
  border-radius: 16px;
  font-family: 'Nunito', sans-serif; font-size: 16px; font-weight: 600; color: #9A3412;
  transition: border-color 180ms ease, box-shadow 180ms ease;
}
.input::placeholder { color: #C4B5A8; font-weight: 600; }
.input:focus {
  border-color: #F97316; outline: none;
  box-shadow: 0 0 0 4px rgba(249,115,22,.18);
}
```

### Modals (clay — chunky panel on warm scrim)

```css
.modal-overlay {
  background: rgba(124,45,18,.4);       /* warm dark scrim, not pure black */
  backdrop-filter: blur(3px);
}
.modal {
  background: #FFFFFF;
  border: 3px solid #FED7AA;
  border-radius: 28px;
  padding: 36px;
  box-shadow: 8px 10px 0 rgba(194,65,12,.18);
  max-width: 520px; width: 92%;
}
```

---

## Style Guidelines

**Style:** Claymorphism

**Keywords:** Soft 3D, chunky, playful, toy-like, bubbly, thick borders (3-4px), hard offset shadows, rounded (16-24px)

**Best For:** Educational apps, children's apps, SaaS platforms, creative tools, fun-focused, onboarding, casual games

**Key Effects:** Hard offset "clay" shadows (no blur) + inner highlight for volume, **soft-press buttons** (lift on hover, press on active, 180-200ms ease-out), playful hover tilt (`rotate(-0.5deg)`), fluffy/rounded elements, organic blob shapes for decoration, smooth springy transitions (`cubic-bezier(.34,1.56,.64,1)` for entrances).

**The 5 rules of clay (do not break):**
1. Borders are **always 3px solid** — never 1px hairlines.
2. Shadows are **hard offsets** (`Npx Npx 0`), never soft blurs, on interactive elements.
3. Corners are **chunky** (16-28px) — never sharp, never tiny.
4. Buttons **press** — solid base shadow that grows on hover, collapses on active.
5. Stay **warm** — orange/peach tints for shadows & scrims, never pure gray/black.

### Page Pattern

**Pattern Name:** Scroll-Triggered Storytelling (Playful landing)

- **Conversion Strategy:** Keep the narrative understandable without scroll-driven effects. Use a progress indicator. Mobile: simplify animations. Keep DOM reading order complete; disable parallax and scroll-scrub under reduced motion. Render each section in its final readable state under reduced motion.
- **CTA Placement:** End of each chapter (mini) + Final climax CTA.
- **Section Order (landing):** Sticky nav > Hero (badge + headline + gesture-quiz mock) > Feature grid (6 clay tiles) > Stats band (clay stat cards) > Climax CTA (blue clay panel) > Footer.
- **Decoration:** organic, absolutely-positioned blob shapes at low opacity behind the hero — never emoji, never busy illustrations.
- **Entrance motion:** elements pop in with `back.out` / `cubic-bezier(.34,1.56,.64,1)` overshoot, staggered top-to-bottom.

---

## Motion

**Stagger List** (Standard) — Trigger: load or scroll | Duration: 300-450ms | Easing: `back.out(1.4)`

```js
gsap.from('.grid-item', { opacity: 0, scale: 0.92, y: 16, duration: 0.4, stagger: { each: 0.06, from: 'start', grid: 'auto' }, ease: 'back.out(1.4)' });
```

**Framework notes:** grid: 'auto' lets GSAP infer rows/columns from a CSS grid layout for a natural wave stagger; Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Combine with from: 'center' for a bento-grid layout to draw the eye inward first
- ❌ Don't use back.out on dense data tables; the overshoot reads as sloppy on informational UI
- ⚡ Group DOM writes; avoid interleaving layout reads (getBoundingClientRect) between staggered tweens

---

## Anti-Patterns (Do NOT Use)

- ❌ Generic design
- ❌ No personality
- ❌ **Flat corporate styling** — 1px hairline borders, soft blurred drop-shadows, or sharp corners kill the clay look
- ❌ **Pure gray/black shadows & scrims** — keep them warm (orange/peach-tinted)

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons). *(The approved mockup uses temporary emoji glyphs as placeholders; swap to Lucide/Heroicons during the real build.)*
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Use transform (translate/rotate), not properties that reflow layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum. Note: body text `#9A3412` on `#FFF7ED` and on `#FFFFFF` both pass; verify any orange-on-orange combos.
- ❌ **Instant state changes** — Always use transitions (150-300ms); soft-press is 180ms ease-out
- ❌ **Invisible focus states** — Focus states must be visible (3px blue outline) for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
