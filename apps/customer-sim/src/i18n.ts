// All simulator strings in one catalog (same approach as apps/pos). French first, English via navigator.language or the switch.
const en = {
  banner: "SANDBOX customer wallet (simulator, not a real wallet)",
  title: "Pay a Jaay QR",
  hint: "Paste the payment string from the merchant screen (it starts with LIGHTNING: or LNURL).",
  input: "Payment string",
  read: "Read",
  scan: "Scan with camera",
  stopScan: "Stop camera",
  step1: "1. Payment request",
  amount: "Amount: {msat} msat ({sats} sats)",
  xof: "Merchant price: {xof}",
  fixedAmount: "Fixed amount (minimum equals maximum): OK",
  pay: "Pay (simulated)",
  step2: "2. Invoice",
  network: "Network: {net}",
  invAmount: "Invoice amount: {msat} msat",
  hashOk: "Description hash matches the payment request: yes",
  hashBad: "Description hash matches the payment request: NO",
  step3: "3. Paid (simulated)",
  successLink: "Receipt (link from the payment, same server):",
  successText: "Message from the merchant:",
  fallback: "Receipt address printed in the description:",
  notOpened: "Nothing is opened automatically. Tap a link to see the receipt and its 6-digit code.",
  raw: "What a wallet sees (raw responses)",
  error: "Payment failed: {reason}",
  generic: "the request could not be completed",
  lang: "Français",
};
export type Key = keyof typeof en;
const fr: Record<Key, string> = {
  banner: "SANDBOX portefeuille client (simulateur, pas un vrai portefeuille)",
  title: "Payer un QR Jaay",
  hint: "Collez la chaîne de paiement affichée par le marchand (elle commence par LIGHTNING: ou LNURL).",
  input: "Chaîne de paiement",
  read: "Lire",
  scan: "Scanner avec la caméra",
  stopScan: "Arrêter la caméra",
  step1: "1. Demande de paiement",
  amount: "Montant : {msat} msat ({sats} sats)",
  xof: "Prix du marchand : {xof}",
  fixedAmount: "Montant fixe (minimum égal au maximum) : OK",
  pay: "Payer (simulé)",
  step2: "2. Facture",
  network: "Réseau : {net}",
  invAmount: "Montant de la facture : {msat} msat",
  hashOk: "Le hash de description correspond à la demande : oui",
  hashBad: "Le hash de description correspond à la demande : NON",
  step3: "3. Payé (simulé)",
  successLink: "Reçu (lien du paiement, même serveur) :",
  successText: "Message du marchand :",
  fallback: "Adresse du reçu imprimée dans la description :",
  notOpened: "Rien ne s'ouvre tout seul. Touchez un lien pour voir le reçu et son code à 6 chiffres.",
  raw: "Ce que voit un portefeuille (réponses brutes)",
  error: "Paiement échoué : {reason}",
  generic: "la demande n'a pas abouti",
  lang: "English",
};
export const CATALOG = { en, fr } as const;
export type Lang = keyof typeof CATALOG;

let lang: Lang = "fr";
export function initLang(navLang: string | undefined): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("jaay.lang");
  } catch {
    stored = null;
  }
  lang = stored === "en" || stored === "fr" ? stored : navLang?.toLowerCase().startsWith("en") ? "en" : "fr";
  return lang;
}
export function toggleLang(): Lang {
  lang = lang === "fr" ? "en" : "fr";
  try {
    localStorage.setItem("jaay.lang", lang);
  } catch {
    /* session only */
  }
  return lang;
}
export const t = (k: Key, v: Record<string, string | number> = {}) => CATALOG[lang][k].replace(/\{(\w+)\}/g, (_, x: string) => String(v[x] ?? ""));
