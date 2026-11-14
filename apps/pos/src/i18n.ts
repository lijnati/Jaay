// Every user-facing string, in one catalog. French first; English via the switch or navigator.language.
const en = {
  "sandbox.banner": "SANDBOX: simulated payments, no real bitcoin",
  "net.online": "Online",
  "net.offline": "Offline",
  "tab.sell": "Sell",
  "tab.ledger": "Sales",
  "tab.wallet": "Wallet",
  "tab.settings": "Settings",

  "enroll.title": "Set up this device",
  "enroll.hint": "Paste the enrollment code from your Jaay server, or open the enrollment link on this phone.",
  "enroll.read": "Read code",
  "enroll.invalid": "This enrollment code is not valid.",
  "enroll.wrongServer": "This code is for another server than the one this app came from. Refused.",
  "enroll.server": "Payments will go to:",
  "enroll.details": "{label}, sales from {min} to {max}",
  "enroll.sandbox": "This is a SANDBOX server: payments are simulated.",
  "enroll.confirmHost": "This is my server: {host}",
  "enroll.submit": "Set up this device",
  "enroll.done": "Device ready.",

  "sell.title": "New sale",
  "sell.limits": "From {min} to {max}",
  "sell.create": "Show QR code",
  "sell.offlineOk": "Offline: you can still sell. Payments are checked when you are back online.",
  "sell.backspace": "Delete last digit",
  "sell.clear": "Clear",
  "sell.payTo": "Pays to {host}",
  "sell.validFor": "Valid for {time}",
  "sell.windowOver": "Sale time is over",
  "sell.enterCode": "Customer paid: enter code",
  "sell.newSale": "New sale",
  "sell.cancel": "Cancel sale",
  "sell.cancelConfirm": "Tap again to cancel this sale",
  "sell.cancelled": "Sale cancelled.",

  "confirm.title": "Check the code",
  "confirm.ask": "Ask the customer for the 6-digit code shown on their receipt after paying.",
  "confirm.input": "6-digit code",
  "confirm.check": "Check code",
  "confirm.left": "Attempts left: {n}",
  "confirm.ok": "Payment confirmed.",
  "confirm.wrong": "Code not accepted.",
  "confirm.locked": "Too many wrong codes. This sale is locked and will be checked with the server.",
  "confirm.refused": "This sale cannot be confirmed here. Check it with the server from Sales.",
  "confirm.next": "Next sale",

  "ledger.title": "Sales",
  "ledger.today": "Today: {amount} ({n} sales)",
  "ledger.filterAll": "All",
  "ledger.filterOpen": "Open",
  "ledger.filterAttention": "Attention",
  "ledger.filterPaid": "Paid",
  "ledger.empty": "No sales yet.",
  "ledger.reconcile": "Check with server",
  "ledger.reconciling": "Checking with the server...",
  "ledger.reconciled": "Checked {n} sales at {time}.",
  "ledger.reconcileFailed": "Server not reachable. Will retry automatically.",
  "ledger.offline": "Offline. Sales will be checked when you are back online.",
  "ledger.mismatchNote": "You confirmed this sale but the server shows no matching payment.",
  "ledger.cancelPaidNote": "Paid after you cancelled it: a refund may be needed.",

  "status.open": "open",
  "status.confirmed": "confirmed",
  "status.locked": "locked",
  "status.cancelled": "cancelled",
  "status.expired": "time over",
  "status.paid": "paid",
  "status.paid_late": "paid late",
  "status.unpaid": "unpaid",
  "status.mismatch": "mismatch",

  "wallet.title": "Wallet",
  "wallet.receiveOnly": "Receive only. This app and the server cannot spend.",
  "wallet.spendMethods": "Spend permissions detected: {list}",
  "wallet.none": "none",
  "wallet.backend": "Backend: {label}",
  "wallet.unavailable": "The backend wallet is not reachable right now.",
  "wallet.balance": "Balance: {sats} sats",
  "wallet.balanceNote": "As reported by the backend wallet.",
  "wallet.today": "Received today",
  "wallet.allTime": "Received in total",
  "wallet.sats": "{sats} sats, {n} sales",
  "wallet.recent": "Last payments",
  "wallet.noData": "No wallet data yet. Connect to the internet to load it.",
  "wallet.cached": "Offline. Last updated {age} ago.",
  "wallet.refresh": "Refresh",
  "wallet.notReceiveOnly": "Warning: the wallet connection now allows spending. Contact your operator.",

  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.window": "Sale time limit",
  "settings.minutes": "{n} minutes",
  "settings.label": "Shop name on this device",
  "settings.save": "Save",
  "settings.host": "Server",
  "settings.version": "Version {v}",
  "settings.upToDate": "App is up to date.",
  "settings.updateReady": "An update is ready.",
  "settings.updateAfterSale": "An update is ready. Finish or cancel the open sale first.",
  "settings.update": "Update now",
  "settings.wipe": "Wipe this device",
  "settings.wipeConfirm": "Tap again to erase keys and all sales from this phone",

  "time.min": "{n} min",
  "time.h": "{n} h",
  "time.d": "{n} d",

  "demo.tryShop": "Try the sandbox demo shop",
  "demo.tryHint": "Creates a SANDBOX shop on this server for this phone. Payments are simulated, no real bitcoin.",
  "demo.copy": "Copy payment string",
  "demo.copied": "Payment string copied.",
  "demo.openSim": "Open customer simulator",
  "demo.title": "Demo data (SANDBOX)",
  "demo.load": "Load demo data",
  "demo.remove": "Remove demo data",
  "demo.loaded": "{n} demo sales loaded.",
  "demo.removed": "{n} demo sales removed.",
  "demo.failed": "Could not reach the server.",
  "demo.badge": "demo",
};

export type Key = keyof typeof en;

const fr: Record<Key, string> = {
  "sandbox.banner": "SANDBOX : paiements simulés, aucun vrai bitcoin",
  "net.online": "En ligne",
  "net.offline": "Hors ligne",
  "tab.sell": "Vendre",
  "tab.ledger": "Ventes",
  "tab.wallet": "Portefeuille",
  "tab.settings": "Réglages",

  "enroll.title": "Configurer cet appareil",
  "enroll.hint": "Collez le code d'enrôlement de votre serveur Jaay, ou ouvrez le lien d'enrôlement sur ce téléphone.",
  "enroll.read": "Lire le code",
  "enroll.invalid": "Ce code d'enrôlement n'est pas valide.",
  "enroll.wrongServer": "Ce code concerne un autre serveur que celui de cette application. Refusé.",
  "enroll.server": "Les paiements iront vers :",
  "enroll.details": "{label}, ventes de {min} à {max}",
  "enroll.sandbox": "Serveur SANDBOX : les paiements sont simulés.",
  "enroll.confirmHost": "C'est bien mon serveur : {host}",
  "enroll.submit": "Configurer cet appareil",
  "enroll.done": "Appareil prêt.",

  "sell.title": "Nouvelle vente",
  "sell.limits": "De {min} à {max}",
  "sell.create": "Afficher le QR code",
  "sell.offlineOk": "Hors ligne : vous pouvez vendre. Les paiements seront vérifiés au retour du réseau.",
  "sell.backspace": "Effacer le dernier chiffre",
  "sell.clear": "Effacer",
  "sell.payTo": "Paiement vers {host}",
  "sell.validFor": "Valable encore {time}",
  "sell.windowOver": "Le temps de la vente est écoulé",
  "sell.enterCode": "Client a payé : saisir le code",
  "sell.newSale": "Nouvelle vente",
  "sell.cancel": "Annuler la vente",
  "sell.cancelConfirm": "Touchez encore pour annuler cette vente",
  "sell.cancelled": "Vente annulée.",

  "confirm.title": "Vérifier le code",
  "confirm.ask": "Demandez au client le code à 6 chiffres affiché sur son reçu après paiement.",
  "confirm.input": "Code à 6 chiffres",
  "confirm.check": "Vérifier le code",
  "confirm.left": "Essais restants : {n}",
  "confirm.ok": "Paiement confirmé.",
  "confirm.wrong": "Code refusé.",
  "confirm.locked": "Trop de codes faux. Cette vente est bloquée et sera vérifiée avec le serveur.",
  "confirm.refused": "Cette vente ne peut pas être confirmée ici. Vérifiez-la avec le serveur depuis Ventes.",
  "confirm.next": "Vente suivante",

  "ledger.title": "Ventes",
  "ledger.today": "Aujourd'hui : {amount} ({n} ventes)",
  "ledger.filterAll": "Toutes",
  "ledger.filterOpen": "En cours",
  "ledger.filterAttention": "À vérifier",
  "ledger.filterPaid": "Payées",
  "ledger.empty": "Aucune vente pour l'instant.",
  "ledger.reconcile": "Vérifier avec le serveur",
  "ledger.reconciling": "Vérification avec le serveur...",
  "ledger.reconciled": "{n} ventes vérifiées à {time}.",
  "ledger.reconcileFailed": "Serveur injoignable. Nouvel essai automatique.",
  "ledger.offline": "Hors ligne. Les ventes seront vérifiées au retour du réseau.",
  "ledger.mismatchNote": "Vous avez confirmé cette vente mais le serveur ne voit aucun paiement correspondant.",
  "ledger.cancelPaidNote": "Payée après annulation : un remboursement peut être nécessaire.",

  "status.open": "en cours",
  "status.confirmed": "confirmée",
  "status.locked": "bloquée",
  "status.cancelled": "annulée",
  "status.expired": "temps écoulé",
  "status.paid": "payée",
  "status.paid_late": "payée en retard",
  "status.unpaid": "non payée",
  "status.mismatch": "écart",

  "wallet.title": "Portefeuille",
  "wallet.receiveOnly": "Réception seulement. Cette application et le serveur ne peuvent pas dépenser.",
  "wallet.spendMethods": "Droits de dépense détectés : {list}",
  "wallet.none": "aucun",
  "wallet.backend": "Portefeuille : {label}",
  "wallet.unavailable": "Le portefeuille n'est pas joignable pour le moment.",
  "wallet.balance": "Solde : {sats} sats",
  "wallet.balanceNote": "Tel qu'indiqué par le portefeuille.",
  "wallet.today": "Reçu aujourd'hui",
  "wallet.allTime": "Reçu au total",
  "wallet.sats": "{sats} sats, {n} ventes",
  "wallet.recent": "Derniers paiements",
  "wallet.noData": "Pas encore de données. Connectez-vous à internet pour les charger.",
  "wallet.cached": "Hors ligne. Mis à jour il y a {age}.",
  "wallet.refresh": "Actualiser",
  "wallet.notReceiveOnly": "Attention : la connexion du portefeuille permet maintenant de dépenser. Contactez votre opérateur.",

  "settings.title": "Réglages",
  "settings.language": "Langue",
  "settings.window": "Durée d'une vente",
  "settings.minutes": "{n} minutes",
  "settings.label": "Nom de la boutique sur cet appareil",
  "settings.save": "Enregistrer",
  "settings.host": "Serveur",
  "settings.version": "Version {v}",
  "settings.upToDate": "L'application est à jour.",
  "settings.updateReady": "Une mise à jour est prête.",
  "settings.updateAfterSale": "Une mise à jour est prête. Terminez ou annulez d'abord la vente en cours.",
  "settings.update": "Mettre à jour",
  "settings.wipe": "Effacer cet appareil",
  "settings.wipeConfirm": "Touchez encore pour effacer les clés et toutes les ventes de ce téléphone",

  "time.min": "{n} min",
  "time.h": "{n} h",
  "time.d": "{n} j",

  "demo.tryShop": "Essayer la boutique de démo SANDBOX",
  "demo.tryHint": "Crée une boutique SANDBOX sur ce serveur pour ce téléphone. Paiements simulés, aucun vrai bitcoin.",
  "demo.copy": "Copier la chaîne de paiement",
  "demo.copied": "Chaîne de paiement copiée.",
  "demo.openSim": "Ouvrir le simulateur client",
  "demo.title": "Données de démo (SANDBOX)",
  "demo.load": "Charger les données de démo",
  "demo.remove": "Supprimer les données de démo",
  "demo.loaded": "{n} ventes de démo chargées.",
  "demo.removed": "{n} ventes de démo supprimées.",
  "demo.failed": "Serveur injoignable.",
  "demo.badge": "démo",
};

export const CATALOG = { en, fr } as const;
export type Lang = keyof typeof CATALOG;

const STORE_KEY = "jaay.lang"; // a preference, not a secret
let lang: Lang = "fr";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

/** Stored choice, else navigator.language (English only if it starts with "en"), else French. */
export function initLang(navLang: string | undefined): Lang {
  const stored = readStored();
  lang = stored === "en" || stored === "fr" ? stored : navLang?.toLowerCase().startsWith("en") ? "en" : "fr";
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
  try {
    localStorage.setItem(STORE_KEY, l);
  } catch {
    /* private mode: the choice lasts for this session */
  }
}

export const getLang = () => lang;

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return CATALOG[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
