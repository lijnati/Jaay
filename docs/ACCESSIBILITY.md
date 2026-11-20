# Accessibility

Measured 2026-11-20 on the `redesign` branch. Real screen readers, real phones, Safari and Firefox: NOT RUN.

## What is checked automatically

- Contrast: every text and control pair is computed (WCAG 2.x relative luminance) in [DESIGN.md](DESIGN.md#contrast-computed-wcag-2x-relative-luminance). All text pairs are AA or better; hero amounts are AAA; control borders are 3.59:1. Amber is decoration only.
- No horizontal scroll on any screen at 320, 360 and 412 px in English and French (Playwright `layout` step, 84 screen checks per run; 112 with the 1280 px desktop view).
- The primary action on the sell screen ("Customer paid? Enter the code") is visible without scrolling at 640 px high on 320, 360 and 412 px.
- Every user-visible string exists in EN and FR (catalog completeness tests in the PWA, simulator and receipt).

## Design rules that support it

- Touch targets: 48 px minimum (keys 64 px, buttons 52 px, tabs 60 px).
- Status is never colour alone: chips carry an icon and a word; the online pill has a word; the attempt dots sit next to the attempt text.
- One input for the confirm code, with `inputmode="numeric"`, a pattern, a label and `aria-describedby` pointing at the attempts or result text; results use `role="status"`.
- Icons are `aria-hidden`; the backspace key has an accessible name; tabs mark the current page with `aria-current`; filter pills and the language switch use `aria-pressed`.
- Focus: a 3 px brand outline with offset on every control.
- `prefers-reduced-motion: reduce` removes all animation; the screenshot runs use it and every screen (including the drawn check mark) renders complete.
- `forced-colors: active` gives controls, chips, cards and the banner a system border, and the QR keeps its own colours. Visual check in a forced-colours browser: NOT RUN.

## Not run

- axe-core 4.14.0 (WCAG 2.1 A and AA), run on every layout screen at 320 and 360 px in EN and FR with `E2E_ONLY=layout E2E_AXE=<path to axe.min.js> pnpm --filter @jaay/pos test:e2e` (axe is a local copy, not a dependency). Result: 0 serious or critical issues on the PWA and the simulator. One open critical on the server receipt before payment: `meta-refresh`, because the page reloads every 5 seconds while it waits (it has no JavaScript by design). Removing it changes server behaviour, so it is left for an owner decision. The simulator's raw-response blocks are now keyboard focusable (axe `scrollable-region-focusable`).
