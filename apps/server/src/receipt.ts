// Receipt page: no JavaScript, one inline stylesheet pinned by hash in the CSP, FR first with EN via Accept-Language.
// The confirm code is a parameter of the "paid" view only; no other view can render it.
import { createHash } from "node:crypto";
import type { ReceiptView } from "./sales";

const CSS =
  "body{margin:0;font:18px/1.4 system-ui,sans-serif;background:#fff;color:#000}" +
  "main{max-width:420px;margin:0 auto;padding:24px 16px;text-align:center}" +
  ".w{font-weight:700;letter-spacing:.02em}.code{font:700 56px/1.1 ui-monospace,monospace;letter-spacing:.12em;margin:16px 0}" +
  ".amt{font-size:28px;font-weight:700}.muted{color:#444;font-size:15px}.ok{color:#0a7d32}.late{color:#8a5a00}" +
  ".sb{background:#000;color:#fff;font-size:13px;padding:6px;text-align:center}";
export const RECEIPT_CSP = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(CSS).digest("base64")}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

type Lang = "fr" | "en";
export function pickLang(acceptLanguage: string | undefined): Lang {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "fr";
}

const T = {
  fr: {
    title: "Recu",
    pending: "Pas encore paye",
    pendingHint: "Cette page se met a jour toute seule.",
    generic: "Recu introuvable ou expire",
    paid: "Paye",
    late: "Paiement tardif accepte",
    code: "Code de confirmation a dire au marchand",
    sandbox: "SANDBOX : paiement simule, aucun vrai bitcoin",
  },
  en: {
    title: "Receipt",
    pending: "Not paid yet",
    pendingHint: "This page refreshes by itself.",
    generic: "Receipt not found or expired",
    paid: "Paid",
    late: "Late payment accepted",
    code: "Confirmation code to read to the merchant",
    sandbox: "SANDBOX: simulated payment, no real bitcoin",
  },
} as const;

const fmtXof = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} XOF`;
const fmtTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function renderReceipt(view: ReceiptView, lang: Lang, sandbox: boolean): string {
  const t = T[lang];
  let body: string;
  let refresh = "";
  if (view.kind === "paid") {
    body =
      `<p class="${view.late ? "late" : "ok"}">${view.late ? t.late : t.paid}</p>` +
      `<p class="amt">${fmtXof(view.amountXof)}</p><p class="muted">${fmtTime(view.paidAt)}</p>` +
      `<p class="muted">${t.code}</p><p class="code">${view.code}</p>`;
  } else if (view.kind === "pending") {
    refresh = '<meta http-equiv="refresh" content="5">';
    body = `<p class="amt">${t.pending}</p><p class="muted">${t.pendingHint}</p>`;
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
