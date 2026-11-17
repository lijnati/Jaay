// jaay merchant PWA. Vanilla DOM: every value goes through textContent, never innerHTML.
// Screens: enroll, sell (keypad + QR), confirm, ledger, wallet, settings. No send or pay code path exists.
import "./styles.css";
import { buildSaleLnurl, encodeSale, toQrString, type DeviceKeys } from "@jaay/protocol";
import { devicePost } from "./auth";
import { attemptsLeftText, confirmText, tryConfirm, MAX_ATTEMPTS, type ConfirmResult } from "./confirm";
import { allSales, getConfig, getKeys, getKv, getSale, putConfig, putKv, putSale, wipe, type DeviceConfig, type SaleRec } from "./db";
import { enrollDevice, parseEnrollPayload, readEnrollFragment, type EnrollPayload } from "./enroll";
import { getLang, initLang, setLang, t, type Key, type Lang } from "./i18n";
import { loadDemo, removeDemo, sandboxHelpers } from "./demo";
import { transition, type LedgerStatus } from "./ledger";
import { formatXof, groupDigits } from "./money";
import { renderQr } from "./qr";
import { runReconcile } from "./reconcile";

declare const __BUILD__: string;

type Screen = "enroll" | "sell" | "confirm" | "ledger" | "wallet" | "settings";
interface WalletCache {
  at: number;
  data: {
    receiveOnly: boolean;
    backend: { label: string; available: boolean; spendMethods: string[] | null; balanceMsat: string | null };
    totals: { today: { xof: number; msat: string; count: number }; allTime: { xof: number; msat: string; count: number } };
    recent: { sid: string; amountXof: number; paidAt: string; status: string; demo?: boolean }[];
  };
}

const state: {
  screen: Screen;
  config?: DeviceConfig;
  keys?: DeviceKeys;
  digits: string;
  sid: string | null;
  enrollText: string;
  enrollParsed: EnrollPayload | null;
  enrollError: Key | null;
  filter: "all" | "open" | "attention" | "paid";
  recon: { kind: "idle" | "running" | "ok" | "fail" | "offline"; n?: number; at?: number };
  confirmMsg: ConfirmResult | null;
  /** Keeps the collapsed sections open across re-renders. */
  open: { demoTools: boolean; walletDetails: boolean };
  armed: string | null;
  updateWaiting: boolean;
  /** From GET /healthz: is this server a SANDBOX server (offers the demo shop)? */
  serverSandbox: boolean;
  note: { kind: "ok" | "err"; text: string } | null;
} = {
  screen: "sell",
  digits: "",
  sid: null,
  enrollText: "",
  enrollParsed: null,
  enrollError: null,
  filter: "all",
  recon: { kind: "idle" },
  confirmMsg: null,
  open: { demoTools: false, walletDetails: false },
  armed: null,
  updateWaiting: false,
  serverSandbox: false,
  note: null,
};

// ---------- tiny DOM helper ----------
type Attrs = Record<string, string | boolean | undefined | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k !== null && k !== false && k !== undefined) el.append(k);
  return el;
}
/** A collapsed section whose open state survives re-renders. */
function fold(id: string, which: keyof typeof state.open, title: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElement {
  const d = h("details", { id, open: state.open[which] }, h("summary", { text: title }), ...kids);
  d.addEventListener("toggle", () => (state.open[which] = (d as HTMLDetailsElement).open));
  return d;
}
/** Date and time without seconds, in the app language. */
const when = (ms: number | string) => new Intl.DateTimeFormat(getLang(), { dateStyle: "short", timeStyle: "short" }).format(new Date(ms));
const host = () => (state.config ? new URL(state.config.baseUrl).host : "");
const now = () => Date.now();
let ticker: ReturnType<typeof setInterval> | undefined;

// ---------- sales ----------
async function createSale(): Promise<void> {
  const c = state.config!;
  const amountXof = Number(state.digits);
  if (!Number.isSafeInteger(amountXof) || amountXof < c.minXof || amountXof > c.maxXof) return;
  const { token, sid } = await encodeSale(state.keys!, c.deviceId, { amountXof }, { minAmountXof: c.minXof, maxAmountXof: c.maxXof });
  const created = now();
  await putSale({
    sid,
    amountXof,
    createdAt: created,
    windowEndsAt: created + c.saleWindowMin * 60_000,
    status: "open",
    attempts: 0,
    qr: toQrString(buildSaleLnurl(c.baseUrl, token)),
  });
  state.digits = "";
  await setActive(sid);
  render();
}

async function setActive(sid: string | null): Promise<void> {
  state.sid = sid;
  state.confirmMsg = null;
  await putKv("active", sid);
}

/** Local sale window: device clock, display only. The server decides what was paid. */
async function expireIfOver(rec: SaleRec): Promise<SaleRec> {
  if (rec.status === "open" && now() > rec.windowEndsAt) {
    const next = { ...rec, status: transition("open", "expire")! };
    await putSale(next);
    return next;
  }
  return rec;
}

async function changeStatus(sid: string, event: "cancel"): Promise<void> {
  const rec = await getSale(sid);
  const next = rec && transition(rec.status, event);
  if (rec && next) await putSale({ ...rec, status: next });
}

const saleOnScreen = async () => {
  if (!state.sid) return false;
  const rec = await getSale(state.sid);
  return !!rec && (rec.status === "open" || rec.status === "expired");
};

// ---------- reconcile (never blocks selling) ----------
let reconDelay = 5000;
let reconTimer: ReturnType<typeof setTimeout> | undefined;
async function reconcile(): Promise<void> {
  if (!state.config || !state.keys || state.recon.kind === "running") return;
  if (!navigator.onLine) {
    state.recon = { kind: "offline" };
    return refreshIf("ledger");
  }
  state.recon = { kind: "running" };
  refreshIf("ledger");
  clearTimeout(reconTimer);
  try {
    const r = await runReconcile({ fetchFn: fetch.bind(globalThis), config: state.config, keys: state.keys, now: now() });
    state.recon = { kind: "ok", n: r.sent, at: now() };
    reconDelay = 5000;
  } catch {
    state.recon = { kind: "fail" };
    reconTimer = setTimeout(() => void reconcile(), reconDelay);
    reconDelay = Math.min(reconDelay * 2, 300_000);
  }
  refreshIf("ledger");
  refreshIf("sell");
}

async function loadWallet(): Promise<void> {
  if (!state.config || !state.keys || !navigator.onLine) return;
  try {
    const data = await devicePost<WalletCache["data"]>(fetch.bind(globalThis), state.config.baseUrl, state.config.deviceId, state.keys.auth, "/v1/wallet/summary", {}, now());
    await putKv("wallet", { at: now(), data } satisfies WalletCache);
  } catch {
    /* keep the cached summary */
  }
  refreshIf("wallet");
}

function refreshIf(s: Screen): void {
  if (state.screen === s) render();
}

// ---------- screens ----------
function enrollScreen(): HTMLElement {
  const p = state.enrollParsed;
  const input = h("textarea", { id: "enroll-input", "aria-label": t("enroll.title"), autocomplete: "off", spellcheck: "false" }) as HTMLTextAreaElement;
  input.value = state.enrollText;
  const check = h("input", { type: "checkbox", id: "enroll-check" }) as HTMLInputElement;
  const submit = h("button", { class: "btn", id: "enroll-submit", disabled: true, text: t("enroll.submit") }) as HTMLButtonElement;
  check.addEventListener("change", () => (submit.disabled = !check.checked));
  submit.addEventListener("click", async () => {
    if (!p || !check.checked) return;
    try {
      state.config = await enrollDevice(p, location.origin, now());
      state.keys = await getKeys();
      state.enrollText = "";
      state.enrollParsed = null;
      state.screen = "sell";
      render();
      void reconcile();
    } catch {
      state.enrollError = "enroll.wrongServer";
      state.enrollParsed = null;
      render();
    }
  });
  const demoShop = async () => {
    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Boutique demo Jaay", backend: "sandbox", connection: "", minXof: 50, maxXof: 500000 }),
      });
      const j = (await res.json()) as { deviceId?: string; deviceSecretB64u?: string; baseUrl?: string; sandbox?: boolean };
      // Through the normal parser and the normal confirm card. The secret is never shown in the text box.
      state.enrollParsed = parseEnrollPayload(
        JSON.stringify({ deviceId: j.deviceId, deviceSecretB64u: j.deviceSecretB64u, baseUrl: j.baseUrl, minXof: 50, maxXof: 500000, label: "Boutique demo Jaay", sandbox: j.sandbox === true }),
      );
      state.enrollError = state.enrollParsed ? null : "enroll.invalid";
    } catch {
      state.enrollError = "enroll.invalid";
    }
    render();
  };
  return h(
    "section",
    {},
    h("h1", { text: t("enroll.title") }),
    state.serverSandbox &&
      !p &&
      h("div", { class: "card" }, h("button", { class: "btn", id: "demo-shop", text: t("demo.tryShop"), onclick: () => void demoShop() }), h("p", { class: "hint", text: t("demo.tryHint") })),
    h("p", { class: "hint", text: t("enroll.hint") }),
    input,
    h("button", {
      class: "btn secondary",
      id: "enroll-read",
      text: t("enroll.read"),
      onclick: () => {
        state.enrollText = input.value;
        state.enrollParsed = parseEnrollPayload(input.value);
        state.enrollError = state.enrollParsed ? null : "enroll.invalid";
        if (state.enrollParsed && new URL(state.enrollParsed.baseUrl).origin !== location.origin) {
          state.enrollError = "enroll.wrongServer";
          state.enrollParsed = null;
        }
        render();
      },
    }),
    state.enrollError && h("p", { class: "msg err", role: "alert", text: t(state.enrollError) }),
    p &&
      h(
        "div",
        { class: "card" },
        h("p", { text: t("enroll.server") }),
        h("p", { class: "host", id: "enroll-host", text: new URL(p.baseUrl).host }),
        h("p", { class: "hint", text: t("enroll.details", { label: p.label, min: formatXof(p.minXof), max: formatXof(p.maxXof) }) }),
        p.sandbox && h("p", { class: "msg warn", text: t("enroll.sandbox") }),
        h("label", { class: "check" }, check, document.createTextNode(t("enroll.confirmHost", { host: new URL(p.baseUrl).host }))),
        submit,
      ),
  );
}

function keypad(): HTMLElement {
  const press = (d: string) => () => {
    if (d === "C") state.digits = "";
    else if (d === "<") state.digits = state.digits.slice(0, -1);
    else if ((state.digits + d).length <= 10) state.digits = (state.digits + d).replace(/^0+/, "");
    render();
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "<"];
  return h(
    "div",
    { class: "keypad" },
    ...keys.map((k) =>
      h("button", { "data-key": k, "aria-label": k === "<" ? t("sell.backspace") : undefined, text: k === "<" ? "⌫" : k, onclick: press(k) }),
    ),
  );
}

/** SANDBOX only (sandboxHelpers returns null otherwise): copy the payment string, open the customer simulator. */
function sandboxButtons(helpers: ReturnType<typeof sandboxHelpers>): (HTMLElement | null)[] {
  if (!helpers) return [];
  return [
    fold("demo-tools", "demoTools", t("demo.tools"),
    h("div", { class: "row" },
      h("button", {
        class: "btn secondary",
        id: "copy",
        text: t("demo.copy"),
        onclick: async () => {
          await navigator.clipboard.writeText(helpers.copy).then(
            () => (state.note = { kind: "ok", text: t("demo.copied") }),
            () => (state.note = { kind: "err", text: helpers.copy }),
          );
          render();
        },
      }),
      h("a", { class: "btn secondary", id: "open-sim", href: helpers.simUrl, target: "_blank", rel: "noopener noreferrer", text: t("demo.openSim") }),
    ),
    state.note && h("p", { class: `msg ${state.note.kind}`, id: "note", role: "status", text: state.note.text }),
    ),
  ];
}

async function sellScreen(): Promise<HTMLElement> {
  const c = state.config!;
  let rec = state.sid ? await getSale(state.sid) : undefined;
  if (rec) rec = await expireIfOver(rec);
  if (!rec || (rec.status !== "open" && rec.status !== "expired")) {
    if (state.sid) await setActive(null);
    const amount = Number(state.digits || "0");
    const ok = amount >= c.minXof && amount <= c.maxXof;
    return h(
      "section",
      {},
      h("h1", { text: t("sell.title") }),
      h("p", { class: "amount", id: "amount", text: formatXof(amount) }),
      h("p", { class: "hint", text: t("sell.limits", { min: formatXof(c.minXof), max: formatXof(c.maxXof) }) }),
      keypad(),
      h("button", { class: "btn secondary", id: "clear", text: t("sell.clear"), onclick: () => ((state.digits = ""), render()) }),
      h("button", { class: "btn", id: "create", disabled: !ok, text: t("sell.create"), onclick: () => void createSale() }),
      !navigator.onLine && h("p", { class: "hint", text: t("sell.offlineOk") }),
    );
  }
  const sale = rec;
  const canvas = h("canvas", { id: "qr", width: "300", height: "300", role: "img", "aria-label": t("sell.payTo", { host: host() }), "data-qr": sale.qr }) as HTMLCanvasElement;
  renderQr(canvas, sale.qr);
  const count = h("p", { class: "count", id: "count" });
  const tick = () => {
    const left = sale.windowEndsAt - now();
    count.textContent = left > 0 ? t("sell.validFor", { time: `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}` }) : t("sell.windowOver");
  };
  tick();
  ticker = setInterval(tick, 1000);
  const armedCancel = state.armed === `cancel:${sale.sid}`;
  return h(
    "section",
    {},
    h("p", { class: "amount sale", id: "sale-amount", text: formatXof(sale.amountXof) }),
    h("div", { class: "qrwrap" }, canvas),
    h("p", { class: "scan", text: t("sell.scanHint") }),
    h("p", { class: "host", id: "host", text: t("sell.payTo", { host: host() }) }),
    count,
    h("button", { class: "btn", id: "to-confirm", text: t("sell.enterCode"), onclick: () => ((state.screen = "confirm"), render()) }),
    h("button", {
      class: "btn danger",
      id: "cancel",
      text: armedCancel ? t("sell.cancelConfirm") : t("sell.cancel"),
      onclick: async () => {
        if (!armedCancel) return ((state.armed = `cancel:${sale.sid}`), render());
        state.armed = null;
        await changeStatus(sale.sid, "cancel");
        await setActive(null);
        render();
      },
    }),
    // Leaves this sale open in the ledger (several sales can be in flight) and goes back to the keypad.
    h("button", { class: "btn secondary", id: "new-sale", text: t("sell.newSale"), onclick: async () => (await setActive(null), render()) }),
    ...sandboxButtons(sandboxHelpers(c, sale.qr)),
    !navigator.onLine && h("p", { class: "hint", text: t("sell.offlineOk") }),
  );
}

async function confirmScreen(): Promise<HTMLElement> {
  const rec = state.sid ? await getSale(state.sid) : undefined;
  if (!rec) return ((state.screen = "sell"), sellScreen());
  const input = h("input", {
    class: "code",
    id: "code",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    maxlength: "6",
    pattern: "[0-9]{6}",
    required: true,
    "aria-label": t("confirm.input"),
    "aria-describedby": state.confirmMsg === null ? "attempts" : "result",
  }) as HTMLInputElement;
  const r = state.confirmMsg;
  const done = r === "confirmed";
  const checkBtn = h("button", { class: "btn", id: "check", disabled: true, text: t("confirm.check") }) as HTMLButtonElement;
  // Only 6 digits can be submitted, so a half-typed code never spends an attempt.
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    checkBtn.disabled = !input.checkValidity();
  });
  checkBtn.addEventListener("click", async () => {
    if (!input.checkValidity()) return;
    state.confirmMsg = await tryConfirm(rec.sid, input.value, state.keys!, now());
    render();
  });
  // Sale identity: its number among that day's sales and its time, so the merchant checks the right one.
  const startOfDay = new Date(rec.createdAt).setHours(0, 0, 0, 0);
  const nth = (await allSales()).filter((s) => s.createdAt >= startOfDay && s.createdAt <= rec.createdAt).length;
  const time = new Intl.DateTimeFormat(getLang(), { timeStyle: "short" }).format(new Date(rec.createdAt));
  // The counter text comes from the persisted record (never from memory), so it matches after a reload.
  const status = r === null ? (rec.attempts < MAX_ATTEMPTS ? attemptsLeftText(rec.attempts, t) : null) : confirmText(r, rec.attempts, t);
  return h(
    "section",
    {},
    h("h1", { text: t("confirm.title") }),
    h("p", { class: "hint", id: "sale-id", text: t("confirm.sale", { n: nth, time }) }),
    h("p", { class: "amount", text: formatXof(rec.amountXof) }),
    !done && h("p", { class: "hint", text: t("confirm.ask") }),
    !done && input,
    status && h("p", { class: r === null ? "hint" : `msg ${done ? "ok" : "err"}`, id: r === null ? "attempts" : "result", role: "status", text: status }),
    !done && checkBtn,
    h("button", {
      class: done ? "btn" : "btn secondary",
      id: "next",
      text: t(done ? "confirm.next" : "confirm.back"),
      onclick: async () => {
        if (done || !(await saleOnScreen())) await setActive(null);
        // Back to sales keeps an open sale open: it stays in the ledger and on the Sell tab.
        state.screen = done ? "sell" : "ledger";
        render();
      },
    }),
  );
}

const ATTENTION: LedgerStatus[] = ["locked", "mismatch", "unpaid"];
async function ledgerScreen(): Promise<HTMLElement> {
  let sales = await allSales();
  sales = await Promise.all(sales.map(expireIfOver));
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const counted = sales.filter((s) => s.createdAt >= startOfDay && ["confirmed", "paid", "paid_late"].includes(s.status));
  const shown = sales.filter((s) =>
    state.filter === "all" ? true : state.filter === "open" ? s.status === "open" || s.status === "expired" : state.filter === "attention" ? ATTENTION.includes(s.status) : s.status === "paid" || s.status === "paid_late",
  );
  const chip = (f: typeof state.filter, key: Key) =>
    h("button", { class: `chip${state.filter === f ? " active" : ""}`, id: `filter-${f}`, "aria-pressed": String(state.filter === f), text: t(key), onclick: () => ((state.filter = f), render()) });
  const r = state.recon;
  const reconText = r.kind === "running" ? t("ledger.reconciling") : r.kind === "ok" ? t("ledger.reconciled", { n: r.n ?? 0, time: new Date(r.at!).toLocaleTimeString() }) : r.kind === "fail" ? t("ledger.reconcileFailed") : r.kind === "offline" ? t("ledger.offline") : "";
  return h(
    "section",
    {},
    h("h1", { text: t("ledger.title") }),
    h("p", { class: "total", id: "day-total", text: t("ledger.today", { amount: formatXof(counted.reduce((a, s) => a + s.amountXof, 0)), n: counted.length }) }),
    h("div", { class: "chips" }, chip("all", "ledger.filterAll"), chip("open", "ledger.filterOpen"), chip("attention", "ledger.filterAttention"), chip("paid", "ledger.filterPaid")),
    h("button", { class: "btn secondary", id: "reconcile", disabled: r.kind === "running", text: t("ledger.reconcile"), onclick: () => void reconcile() }),
    reconText && h("p", { class: r.kind === "fail" ? "msg warn" : "hint", id: "recon-status", role: "status", text: reconText }),
    shown.length === 0
      ? h("p", { class: "hint", text: t("ledger.empty") })
      : h(
          "ul",
          { class: "list", id: "ledger" },
          ...shown.map((s) => {
            const note = s.status === "mismatch" ? (s.server?.status === "paid" || s.server?.status === "paid_late" ? t("ledger.cancelPaidNote") : t("ledger.mismatchNote")) : null;
            const openable = s.status === "open" || s.status === "expired";
            return h(
              "li",
              { "data-sid": s.sid, "data-status": s.status },
              h(
                "div",
                {},
                h("div", { class: "amt", text: formatXof(s.amountXof) }),
                h("div", { class: "when", text: new Date(s.createdAt).toLocaleString() }),
                note && h("div", { class: "hint", text: note }),
                s.demo && h("div", { class: "hint", text: `${t("demo.badge")}: ${s.demoLabel ?? ""}` }),
              ),
              openable
                ? h("button", { class: `st st-${s.status}`, text: t(`status.${s.status}` as Key), onclick: async () => ((state.screen = "confirm"), await setActive(s.sid), render()) })
                : h("span", { class: `st st-${s.status}`, text: t(`status.${s.status}` as Key) }),
            );
          }),
        ),
  );
}

function ago(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? t("time.min", { n: m }) : m < 1440 ? t("time.h", { n: Math.round(m / 60) }) : t("time.d", { n: Math.round(m / 1440) });
}

async function walletScreen(): Promise<HTMLElement> {
  const cache = await getKv<WalletCache>("wallet");
  const sats = (msat: string) => groupDigits(BigInt(msat) / 1000n);
  const d = cache?.data;
  const spend = d?.backend.spendMethods;
  const tag = (cls: string, text: string) => h("span", { class: `st ${cls}`, text });
  return h(
    "section",
    {},
    h("h1", { text: t("wallet.title") }),
    !d && h("p", { class: "hint", id: "wallet-empty", text: t("wallet.noData") }),
    cache && !navigator.onLine && h("p", { class: "msg warn", id: "wallet-age", text: t("wallet.cached", { age: ago(now() - cache.at) }) }),
    d && !d.receiveOnly && h("p", { class: "msg err", text: t("wallet.notReceiveOnly") }),
    d &&
      h(
        "div",
        { class: "card" },
        h("h2", { text: t("wallet.today") }),
        h("p", { class: "total", id: "wallet-today", text: formatXof(d.totals.today.xof) }),
        h("p", { class: "hint", text: t("wallet.sats", { sats: sats(d.totals.today.msat), n: d.totals.today.count }) }),
        h("h2", { text: t("wallet.allTime") }),
        h("p", { class: "total", id: "wallet-all", text: formatXof(d.totals.allTime.xof) }),
        h("p", { class: "hint", text: t("wallet.sats", { sats: sats(d.totals.allTime.msat), n: d.totals.allTime.count }) }),
      ),
    h("p", { class: "badges" }, h("span", { class: "badge", id: "receive-only", text: t("wallet.receiveOnly") })),
    d &&
      fold(
        "wallet-details",
        "walletDetails",
        t("wallet.details"),
        h("p", { class: "hint", id: "spend-methods", text: t("wallet.spendMethods", { list: spend && spend.length ? spend.join(", ") : t("wallet.none") }) }),
        h("p", { class: "hint", text: t("wallet.backend", { label: d.backend.label }) }),
        !d.backend.available && h("p", { class: "msg warn", text: t("wallet.unavailable") }),
        d.backend.balanceMsat != null && h("p", { text: t("wallet.balance", { sats: sats(d.backend.balanceMsat) }) }),
        d.backend.balanceMsat != null && h("p", { class: "hint", text: t("wallet.balanceNote") }),
      ),
    d &&
      d.recent.length > 0 &&
      h(
        "section",
        {},
        h("h2", { text: t("wallet.recent") }),
        h(
          "ul",
          { class: "list", id: "wallet-recent" },
          ...d.recent.map((r) =>
            h(
              "li",
              { "data-demo": r.demo ? "1" : undefined },
              h("div", {}, h("div", { class: "amt", text: formatXof(r.amountXof) }), h("div", { class: "when", text: when(r.paidAt) })),
              h(
                "div",
                { class: "tags" },
                r.demo && tag("st-demo", t("demo.badge")),
                tag(`st-${r.status}`, t(r.status === "paid_late" ? "status.paid_late" : "status.paid")),
              ),
            ),
          ),
        ),
      ),
    h("button", { class: "btn secondary", id: "wallet-refresh", disabled: !navigator.onLine, text: t("wallet.refresh"), onclick: () => void loadWallet() }),
  );
}

async function settingsScreen(): Promise<HTMLElement> {
  const c = state.config!;
  const langSel = h("select", { id: "lang", "aria-label": t("settings.language") }, ...(["fr", "en"] as Lang[]).map((l) => h("option", { value: l, selected: getLang() === l, text: l === "fr" ? "Français" : "English" }))) as HTMLSelectElement;
  langSel.addEventListener("change", () => {
    setLang(langSel.value as Lang);
    document.documentElement.lang = langSel.value;
    render();
  });
  const win = h("select", { id: "window", "aria-label": t("settings.window") }, ...[5, 10, 15, 30].map((n) => h("option", { value: String(n), selected: c.saleWindowMin === n, text: t("settings.minutes", { n }) }))) as HTMLSelectElement;
  win.addEventListener("change", async () => {
    state.config = { ...c, saleWindowMin: Number(win.value) };
    await putConfig(state.config);
  });
  const label = h("input", { id: "label", "aria-label": t("settings.label"), maxlength: "64" }) as HTMLInputElement;
  label.value = c.label;
  const busy = await saleOnScreen();
  const armedWipe = state.armed === "wipe";
  return h(
    "section",
    {},
    h("h1", { text: t("settings.title") }),
    h("h2", { text: t("settings.language") }),
    langSel,
    h("h2", { text: t("settings.window") }),
    win,
    h("h2", { text: t("settings.label") }),
    label,
    h("button", {
      class: "btn secondary",
      text: t("settings.save"),
      onclick: async () => {
        const v = label.value.trim();
        if (!/^[\p{L}\p{N} ._'-]{1,64}$/u.test(v)) return;
        state.config = { ...state.config!, label: v };
        await putConfig(state.config);
        render();
      },
    }),
    h("h2", { text: t("settings.host") }),
    h("p", { class: "host", id: "settings-host", text: host() }),
    h("p", { class: "hint", id: "version", text: t("settings.version", { v: __BUILD__ }) }),
    h("p", { class: "hint", id: "update-status", text: !state.updateWaiting ? t("settings.upToDate") : busy ? t("settings.updateAfterSale") : t("settings.updateReady") }),
    state.updateWaiting && h("button", { class: "btn", id: "update", disabled: busy, text: t("settings.update"), onclick: () => void applyUpdate() }),
    ...(c.sandbox
      ? [
          h("h2", { text: t("demo.title") }),
          h("button", { class: "btn secondary", id: "demo-load", text: t("demo.load"), onclick: () => void demoAction(loadDemo, "demo.loaded") }),
          h("button", { class: "btn secondary", id: "demo-remove", text: t("demo.remove"), onclick: () => void demoAction(removeDemo, "demo.removed") }),
          state.note && h("p", { class: `msg ${state.note.kind}`, id: "demo-note", role: "status", text: state.note.text }),
        ]
      : []),
    h("button", {
      class: "btn danger",
      id: "wipe",
      text: armedWipe ? t("settings.wipeConfirm") : t("settings.wipe"),
      onclick: async () => {
        if (!armedWipe) return ((state.armed = "wipe"), render());
        state.armed = null;
        await wipe();
        state.config = undefined;
        state.keys = undefined;
        state.sid = null;
        state.screen = "enroll";
        render();
      },
    }),
  );
}

async function demoAction(fn: typeof loadDemo, ok: Key): Promise<void> {
  try {
    const n = await fn({ fetchFn: fetch.bind(globalThis), config: state.config!, keys: state.keys!, now: now() });
    state.note = { kind: "ok", text: t(ok, { n }) };
    void loadWallet();
  } catch {
    state.note = { kind: "err", text: t("demo.failed") };
  }
  render();
}

// ---------- shell ----------
let renderSeq = 0;
let lastScreen: Screen | null = null;
async function render(): Promise<void> {
  const seq = ++renderSeq;
  clearInterval(ticker);
  if (!state.config || !state.keys) state.screen = "enroll";
  if (state.screen !== lastScreen) state.note = null;
  lastScreen = state.screen;
  if (state.screen !== "settings" && state.armed === "wipe") state.armed = null;
  const view =
    state.screen === "enroll"
      ? enrollScreen()
      : state.screen === "sell"
        ? await sellScreen()
        : state.screen === "confirm"
          ? await confirmScreen()
          : state.screen === "ledger"
            ? await ledgerScreen()
            : state.screen === "wallet"
              ? await walletScreen()
              : await settingsScreen();
  if (seq !== renderSeq) return; // a newer render started meanwhile
  const tab = (s: Screen, key: Key) =>
    h("button", { id: `tab-${s}`, class: state.screen === s || (s === "sell" && state.screen === "confirm") ? "active" : undefined, text: t(key), onclick: () => ((state.screen = s), s === "wallet" && void loadWallet(), render()) });
  const app = document.getElementById("app")!;
  app.replaceChildren(
    ...[
      state.config?.sandbox ? h("div", { class: "sb", id: "sandbox", role: "note", text: t("sandbox.banner") }) : null,
      h("header", { class: "top" }, h("span", { class: "wm", text: "jaay" }), h("span", { class: `net ${navigator.onLine ? "on" : "off"}`, id: "net", role: "status", text: t(navigator.onLine ? "net.online" : "net.offline") })),
      h("main", { id: "view" }, view),
      state.config ? h("nav", { class: "tabs" }, tab("sell", "tab.sell"), tab("ledger", "tab.ledger"), tab("wallet", "tab.wallet"), tab("settings", "tab.settings")) : null,
    ].filter((x): x is HTMLElement => x !== null),
  );
}

// ---------- service worker: update only when the merchant taps it, never mid-sale ----------
let registration: ServiceWorkerRegistration | undefined;
const hadController = !!navigator.serviceWorker?.controller;
async function applyUpdate(): Promise<void> {
  if (await saleOnScreen()) return;
  registration?.waiting?.postMessage("SKIP_WAITING");
}
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).then((reg) => {
    registration = reg;
    const mark = () => {
      state.updateWaiting = true;
      refreshIf("settings");
    };
    if (reg.waiting && navigator.serviceWorker.controller) mark();
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => w.state === "installed" && navigator.serviceWorker.controller && mark());
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) {
      reloading = true;
      location.reload();
    }
  });
}

// ---------- boot ----------
async function boot(): Promise<void> {
  const lang = initLang(navigator.language);
  document.documentElement.lang = lang;
  const fragment = readEnrollFragment(location, (u) => history.replaceState(null, "", u));
  state.config = await getConfig();
  state.keys = await getKeys();
  if (fragment !== null && !state.config) {
    state.enrollText = fragment;
    state.enrollParsed = parseEnrollPayload(fragment);
    state.enrollError = state.enrollParsed ? null : "enroll.invalid";
  }
  if (!state.config && navigator.onLine) {
    state.serverSandbox = await fetch("/healthz")
      .then((r) => r.json())
      .then((j: { sandbox?: unknown }) => j.sandbox === true)
      .catch(() => false);
  }
  const active = await getKv<string | null>("active");
  if (active) state.sid = active;
  await render();
  window.addEventListener("online", () => {
    render();
    void reconcile();
    void loadWallet();
  });
  window.addEventListener("offline", () => render());
  if (navigator.onLine) {
    void reconcile();
    void loadWallet();
  }
}
void boot();
