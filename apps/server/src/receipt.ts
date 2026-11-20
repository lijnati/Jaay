// Receipt page: no JavaScript, one inline stylesheet pinned by hash in the CSP, FR first with EN via Accept-Language.
// The confirm code is a parameter of the "paid" view only; no other view can render it.
import { createHash } from "node:crypto";
import type { ReceiptView } from "./sales";

// Same tokens as apps/pos/src/tokens.css (m4.test.ts checks every colour used here exists there).
const CSS =
  'body{margin:0;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;background:#F7F5F0;color:#14201B}' +
  ".sb{background:#FEF3C7;color:#78350F;border-bottom:1px solid #F5D68A;font-size:13px;font-weight:650;padding:6px 12px;text-align:center}" +
  "main{max-width:420px;margin:24px auto;padding:0 16px;text-align:center;overflow-wrap:anywhere}" +
  ".card{background:#FFFFFF;border-radius:16px;box-shadow:0 1px 2px rgba(20,32,27,.06),0 8px 24px rgba(20,32,27,.08);padding:24px 20px}" +
  "p{margin:8px 0}.w{display:flex;align-items:center;justify-content:center;gap:8px;font-size:22px;font-weight:800;letter-spacing:-.03em;margin:0 0 16px}.w svg{width:28px;height:28px}" +
  ".muted{color:#5B6760;font-size:14px}.amt{font-size:40px;font-weight:700;letter-spacing:-.03em;margin:4px 0;font-variant-numeric:tabular-nums}" +
  ".st{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:15px;font-weight:700}.st svg{width:18px;height:18px}" +
  ".ok{background:#DCFCE7;color:#14532D}.late{background:#FEF3C7;color:#92400E}" +
  ".draw{stroke-dasharray:24;stroke-dashoffset:24;animation:d .45s ease .1s forwards}@keyframes d{to{stroke-dashoffset:0}}" +
  ".codebox{margin:16px 0 0;padding:12px 8px;border-radius:12px;background:#F7F5F0}" +
  '.code{font:700 56px/1.1 ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.04em;margin:4px 0;white-space:nowrap;font-variant-numeric:tabular-nums}' +
  ".vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
  ".keep{font-weight:700;margin-top:16px}" +
  "@media (max-width:400px){.code{font-size:42px}.amt{font-size:34px}}" +
  "@media (prefers-reduced-motion:reduce){.draw{animation:none;stroke-dashoffset:0}}" +
  "@media (forced-colors:active){.card,.st,.codebox{border:1px solid CanvasText}}";
const MARK =
  '<svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="120" fill="#0B6B4F"/><circle cx="316" cy="140" r="44" fill="#F59E0B"/>' +
  '<path d="M316 250V350A50 50 0 0 1 266 400H196" fill="none" stroke="#FFFFFF" stroke-width="64" stroke-linecap="round"/></svg>';
const ICON = (d: string, cls = "") =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path${cls ? ` class="${cls}"` : ""} d="${d}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = ICON("M5 12.5l4.5 4.5L19 7.5", "draw"), CLOCK = ICON("M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z");
export const RECEIPT_CSP = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(CSS).digest("base64")}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

type Lang = "fr" | "en";
export function pickLang(acceptLanguage: string | undefined): Lang {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "fr";
}

/** Every receipt string, FR and EN (completeness is tested). */
export const RECEIPT_TEXT = {
  fr: {
    title: "Reçu",
    pending: "Pas encore payé",
    fixed: "taux de démo fixe, pas un taux de marché",
    merchant: "Marchand :",
    pendingHint: "En attente de votre paiement. Si vous avez déjà payé, cette page se met à jour dans quelques secondes.",
    checked: "Dernière vérification :",
    generic: "Reçu introuvable ou expiré",
    paid: "Payé",
    late: "Paiement tardif accepté",
    code: "Code de confirmation à dire au marchand",
    keep: "Gardez cette page. C'est votre reçu.",
    sandbox: "SANDBOX : paiement simulé, aucun vrai bitcoin",
  },
  en: {
    title: "Receipt",
    pending: "Not paid yet",
    fixed: "fixed demo rate, not a market rate",
    merchant: "Merchant:",
    pendingHint: "Waiting for your payment. If you already paid, this updates in a few seconds.",
    checked: "Last checked:",
    generic: "Receipt not found or expired",
    paid: "Paid",
    late: "Late payment accepted",
    code: "Confirmation code to read to the merchant",
    keep: "Keep this page. It is your receipt.",
    sandbox: "SANDBOX: simulated payment, no real bitcoin",
  },
} as const;

/** Every interpolated value that did not come from this file goes through esc(). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const fmtSats = (msat: string) => `${String(BigInt(msat) / 1000n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} sats`;
const fmtXof = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} XOF`;
const fmtTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const fmtClock = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
/** "912218" -> "912 218" for reading aloud; the plain digits stay in a visually hidden copy for screen readers. */
const fmtCode = (code: string) => `<span aria-hidden="true">${esc(code.replace(/^(\d{3})(\d{3})$/, "$1 $2"))}</span><span class="vh">${esc(code)}</span>`;

export function renderReceipt(view: ReceiptView, lang: Lang, sandbox: boolean): string {
  const t = RECEIPT_TEXT[lang];
  let body: string;
  let refresh = "";
  if (view.kind === "paid") {
    body =
      `<p class="muted">${t.merchant} ${esc(view.label)}</p>` +
      `<p class="st ${view.late ? "late" : "ok"}">${CHECK}${view.late ? t.late : t.paid}</p>` +
      `<p class="amt">${fmtXof(view.amountXof)}</p><p class="muted">${fmtSats(view.msat)}${view.fixedRate ? ` (${t.fixed})` : ""}</p>` +
      `<p class="muted">${fmtTime(view.paidAt)}</p>` +
      `<div class="codebox"><p class="muted">${t.code}</p><p class="code">${fmtCode(view.code)}</p></div><p class="keep">${t.keep}</p>`;
  } else if (view.kind === "pending") {
    refresh = '<meta http-equiv="refresh" content="5">';
    body =
      `<p class="muted">${t.merchant} ${esc(view.label)}</p><p class="amt">${fmtXof(view.amountXof)}</p>` +
      `<p class="st late">${CLOCK}${t.pending}</p><p>${t.pendingHint}</p><p class="muted">${t.checked} ${fmtClock(view.checkedAt)}</p>`;
  } else {
    body = `<p>${t.generic}</p>`;
  }
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">${refresh}` +
    `<title>jaay ${t.title}</title><style>${CSS}</style></head><body>` +
    (sandbox ? `<div class="sb">${t.sandbox}</div>` : "") +
    `<main><div class="card"><p class="w">${MARK}jaay</p>${body}</div></main></body></html>`
  );
}
