// Receipt page: no JavaScript, one inline stylesheet pinned by hash in the CSP, FR first with EN via Accept-Language.
// The confirm code is a parameter of the "paid" view only; no other view can render it.
import { createHash } from "node:crypto";
import type { ReceiptView } from "./sales";

const CSS =
  "body{margin:0;font:18px/1.4 system-ui,sans-serif;background:#fff;color:#000}" +
  "main{max-width:420px;margin:0 auto;padding:24px 16px;text-align:center}" +
  ".w{font-weight:700;letter-spacing:.02em}.code{font:700 56px/1.1 ui-monospace,monospace;letter-spacing:.12em;margin:16px 0}" +
  ".amt{font-size:28px;font-weight:700}.muted{color:#444;font-size:15px}.ok{color:#0a7d32}.late{color:#8a5a00}" +
  ".sb{background:#000;color:#fff;font-size:13px;padding:6px;text-align:center}" +
  ".vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
  ".keep{font-weight:700;margin-top:24px}main{overflow-wrap:anywhere}";
export const RECEIPT_CSP = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(CSS).digest("base64")}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

type Lang = "fr" | "en";
export function pickLang(acceptLanguage: string | undefined): Lang {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "fr";
}

const T = {
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
  const t = T[lang];
  let body: string;
  let refresh = "";
  if (view.kind === "paid") {
    body =
      `<p class="muted">${t.merchant} ${esc(view.label)}</p>` +
      `<p class="${view.late ? "late" : "ok"}">${view.late ? t.late : t.paid}</p>` +
      `<p class="amt">${fmtXof(view.amountXof)}</p><p class="muted">${fmtSats(view.msat)}${view.fixedRate ? ` (${t.fixed})` : ""}</p>` +
      `<p class="muted">${fmtTime(view.paidAt)}</p>` +
      `<p class="muted">${t.code}</p><p class="code">${fmtCode(view.code)}</p><p class="keep">${t.keep}</p>`;
  } else if (view.kind === "pending") {
    refresh = '<meta http-equiv="refresh" content="5">';
    body =
      `<p class="muted">${t.merchant} ${esc(view.label)}</p><p class="amt">${fmtXof(view.amountXof)}</p>` +
      `<p class="late">${t.pending}</p><p>${t.pendingHint}</p><p class="muted">${t.checked} ${fmtClock(view.checkedAt)}</p>`;
  } else {
    body = `<p>${t.generic}</p>`;
  }
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">${refresh}` +
    `<title>jaay ${t.title}</title><style>${CSS}</style></head><body>` +
    (sandbox ? `<div class="sb">${t.sandbox}</div>` : "") +
    `<main><p class="w">jaay</p>${body}</main></body></html>`
  );
}
