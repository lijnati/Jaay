# Performance and size budgets

Measured 2026-11-20 by the Playwright suite (`f`, `f2`) and `pnpm smoke`, on the `redesign` branch. Gzip level 9.

| Surface | Budget | Before redesign (pre-redesign tag) | After redesign |
|---|---|---|---|
| Merchant PWA first load (HTML, JS, CSS, service worker, manifest, icons) | 150 KB gzipped | 32.4 KB | 37.5 KB (JS 23.2 KB, CSS 3.9 KB) |
| Customer simulator (HTML, JS, CSS) | 40 KB gzipped | 10.7 KB | 14.5 KB |
| Receipt page (paid, HTML with inline CSS and SVG, no JavaScript) | 15 KB | 1,360 bytes | 3,038 bytes |

The app works offline after the first load, including a cold start in airplane mode (Playwright check `c`).

Not measured: Lighthouse and throttled-network load times (NOT RUN), real mid-range phones (NOT RUN).
