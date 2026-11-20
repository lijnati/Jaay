# jaay design system

Adopted 2026-11-20 on the `redesign` branch. Calm, trustworthy, warm fintech for shops in West and East Africa: confident and quiet, legible in bright sunlight and on cheap screens. One product across three surfaces: the merchant PWA (`apps/pos`), the SANDBOX customer simulator (`apps/customer-sim`) and the server-rendered receipt page.

## Source of truth

- `apps/pos/src/tokens.css` defines every token as a CSS custom property. The PWA (`styles.css`) and the simulator (`sim.css` imports the PWA stylesheet) use it directly.
- The receipt page has no external stylesheet (one inline `<style>` pinned by hash in its CSP, no JavaScript). It repeats the token values it needs; `apps/server/src/m4.test.ts` fails if the receipt uses a colour that is not in `tokens.css`.
- System fonts only, no web fonts, no raster images. Icons and illustrations are inline SVG built with DOM calls (no `innerHTML`), each under 1 KB.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--sand` | `#F7F5F0` | page background |
| `--sand-2` | `#EFEDE7` | pressed keys, quiet fills |
| `--surface` | `#FFFFFF` | cards, inputs, the QR card |
| `--ink` | `#14201B` | primary text |
| `--muted` | `#5B6760` | secondary text, helper text |
| `--line` | `#E4E1D8` | decorative dividers only (never the only boundary of a control) |
| `--field` | `#8A877D` | borders of inputs and controls (3:1 non-text contrast) |
| `--brand` / `--brand-ink` | `#0B6B4F` / `#FFFFFF` | primary actions |
| `--brand-soft` | `#E3F1EB` | selected pills, the receive-only badge |
| `--accent` | `#F59E0B` | logo dot and active tab indicator only, never text |
| `--ok` `--ok-text` `--ok-soft` | `#15803D` `#14532D` `#DCFCE7` | paid, confirmed |
| `--warn` `--warn-text` `--warn-soft` | `#B45309` `#92400E` `#FEF3C7` | offline, open, expired, cached data |
| `--err` `--err-text` `--err-soft` | `#B42318` `#9F1D14` `#FEE4E2` | wrong code, locked, unpaid, mismatch, wipe |
| `--sb-bg` `--sb-text` `--sb-line` | `#FEF3C7` `#78350F` `#F5D68A` | SANDBOX banner |
| radius | 16 px cards, 12 px buttons and inputs, 999 px pills | |
| shadow | `0 1px 2px rgba(20,32,27,.06)` and `0 8px 24px rgba(20,32,27,.08)` | cards, the desktop column |
| spacing | 4, 8, 12, 16, 24, 32 px | every margin, padding and gap |

Changes from the starting tokens: status text on tinted backgrounds uses deeper tones (`--ok-text`, `--warn-text`, `--err-text`) because the base status colours on their tints were 4.5 to 4.6:1, too close to the AA line; control borders use `--field` because `#D9D6CC` was 1.45:1.

## Contrast (computed, WCAG 2.x relative luminance)

| Pair | Ratio | Requirement | Result |
|---|---|---|---|
| ink on white | 16.77 | 4.5 (AAA 7) | AAA |
| ink on sand | 15.39 | 4.5 | AAA |
| muted on white | 5.91 | 4.5 | AA |
| muted on sand | 5.42 | 4.5 | AA |
| muted on sand-2 | 5.05 | 4.5 | AA |
| white on brand (primary button) | 6.50 | 4.5 | AA |
| brand on white (links, active tab) | 6.50 | 4.5 | AA |
| brand on sand | 5.97 | 4.5 | AA |
| brand on brand-soft | 5.59 | 4.5 | AA |
| ink on brand-soft | 14.41 | 4.5 | AAA |
| ok-text on ok-soft (paid chip) | 8.30 | 4.5 | AA |
| warn-text on warn-soft | 6.37 | 4.5 | AA |
| err-text on err-soft | 6.54 | 4.5 | AA |
| ok on white | 5.02 | 4.5 | AA |
| warn on white | 5.02 | 4.5 | AA |
| err on white (error text) | 6.57 | 4.5 | AA |
| SANDBOX text on banner | 8.15 | 4.5 | AAA |
| field border on white | 3.59 | 3.0 non-text | AA |
| accent on white | 2.15 | decoration only | not used for information |

Amounts (hero, 40 to 56 px, weight 700) are ink on white or sand: 15.4 to 16.8:1, AAA. Status is never colour alone: every chip has an icon and a word.

## Type

System stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`; monospace for codes and payment strings. Tabular numerals on every amount, countdown and code.

| Role | Size and weight |
|---|---|
| Hero amount | 48 px (40 px on screens under 360 px), 700, tabular |
| Screen title | 24 px, 750 |
| Section title | 17 px, 650 |
| Body | 16 px, line height 1.5 |
| Helper, meta | 14 px muted |
| Chips, banner | 12 to 13 px, 650 |

Room for French: buttons and chips wrap instead of truncating; no fixed widths on text.

## Components

- **Shell:** slim SANDBOX banner (amber tint, brown text, flask icon) above everything in sandbox mode; header with the `jaay` mark (green tile, white hook, amber dot), an online/offline pill with a dot, and a FR/EN segmented control; bottom tab bar with four icons, 56 px tall (48 px minimum targets), active tab in brand colour with an amber indicator, safe-area padding.
- **Buttons:** primary (brand fill), secondary (white, field border), quiet (text only), danger (white, error border and text). 52 px tall, 12 px radius, pressed state scales to 0.98.
- **Cards:** white, 16 px radius, shadow-1; the hero card uses shadow-2.
- **Pills and chips:** 999 px radius; filter pills are toggle buttons (`aria-pressed`); status chips are icon plus word on a soft tint.
- **Keypad:** 3 by 4 grid, 64 px keys, white with a hairline, pressed fill sand-2, backspace as an icon with an accessible name.
- **QR card:** the QR stays black on white with a 16 px quiet zone inside a white card; the host sits under it in a bold chip with a link icon; countdown text plus a thin progress bar.
- **Code input:** one input element, monospace 36 px with wide letter spacing, inside a soft card; three attempt dots (filled = used) beside the existing attempt text.
- **Callouts:** soft tinted box with a 4 px left border in the status colour, used for mismatch notes and messages.

## States and motion

- Pressed 150 ms, focus ring 3 px brand outline with 2 px offset, cards appear with a 220 ms fade and 4 px rise.
- Success (payment confirmed in the PWA, paid receipt): a CSS-only check mark draw (stroke-dashoffset, 450 ms).
- `prefers-reduced-motion: reduce` turns every animation and transition off.
- `forced-colors: active`: controls keep a visible border (`ButtonText`), chips and the banner get borders, focus uses `Highlight`; meaning never depends on colour alone.
- QR codes are always black on white with a quiet zone, in every mode.

## Desktop

Above 560 px the app is a centered column (max 480 px) on the sand background with a soft shadow and rounded corners, and the tab bar stays inside the column. Phones (320 to 412 px) are the primary target.
