// SANDBOX customer wallet (simulator). Every value is written with textContent. No secrets, no auto-open.
import "../../pos/src/styles.css";
import "./sim.css";
import { initLang, t, toggleLang } from "./i18n";
import { fetchPayRequest, invoiceSummary, parseInput, requestInvoice, sandboxPay, successLink, WalletError, type PayRequest } from "./wallet";

type Kid = Node | string | null | false | undefined;
function h(tag: string, attrs: Record<string, string | ((e: Event) => void) | undefined> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== false && k !== undefined) el.append(k);
  return el;
}

const state: { input: string; pay: PayRequest | null; steps: HTMLElement[]; raw: { label: string; body: unknown }[]; error: string | null; busy: boolean } = {
  input: "",
  pay: null,
  steps: [],
  raw: [],
  error: null,
  busy: false,
};
let stopCamera: (() => void) | null = null;

const sats = (msat: string | number) => (BigInt(msat) / 1000n).toLocaleString();
const link = (url: string, id: string) => h("a", { href: url, id, target: "_blank", rel: "noopener noreferrer", text: url });

async function read(): Promise<void> {
  state.pay = null;
  state.steps = [];
  state.raw = [];
  state.error = null;
  try {
    const url = parseInput(state.input);
    const pay = await fetchPayRequest(fetch.bind(globalThis), url);
    state.raw.push({ label: `GET ${url.pathname}`, body: pay.raw });
    state.pay = pay;
    state.steps.push(
      h(
        "div",
        { class: "card", id: "step1" },
        h("h2", { text: t("step1") }),
        h("p", { id: "desc", text: pay.description }),
        h("p", { class: "total", id: "msat", text: t("amount", { msat: pay.amountMsat, sats: sats(pay.amountMsat) }) }),
        pay.xof && h("p", { text: t("xof", { xof: pay.xof }) }),
        h("p", { class: "hint", text: t("fixedAmount") }),
      ),
    );
  } catch (e) {
    state.error = e instanceof WalletError ? e.message : "Error";
  }
  render();
}

async function pay(): Promise<void> {
  const p = state.pay;
  if (!p || state.busy) return;
  state.busy = true;
  render();
  try {
    const inv = await requestInvoice(fetch.bind(globalThis), p);
    state.raw.push({ label: `GET ${p.callback.pathname}?amount=${p.amountMsat}`, body: inv.raw });
    const sum = await invoiceSummary(inv.pr, p.metadata);
    state.steps.push(
      h(
        "div",
        { class: "card", id: "step2" },
        h("h2", { text: t("step2") }),
        h("p", { text: t("network", { net: sum.network }) }),
        h("p", { text: t("invAmount", { msat: sum.msat }) }),
        h("p", { class: sum.descriptionHashOk ? "msg ok" : "msg err", text: t(sum.descriptionHashOk ? "hashOk" : "hashBad") }),
        h("p", { class: "mono", text: inv.pr }),
      ),
    );
    if (!(await sandboxPay(fetch.bind(globalThis), p.callback.origin, sum.paymentHash))) throw new WalletError("Error");
    state.raw.push({ label: `POST /sandbox/pay/${sum.paymentHash.slice(0, 8)}...`, body: { sandbox: true, status: "paid" } });
    const s = successLink(inv.successAction, p.callback);
    state.steps.push(
      h(
        "div",
        { class: "card", id: "step3" },
        h("h2", { text: t("step3") }),
        s && h("p", { text: s.url ? t("successLink") : t("successText") }),
        s && h("p", { id: "success-desc", text: s.description }),
        s?.url && h("p", {}, link(s.url, "success-link")),
        p.receiptUrl && h("p", { class: "hint", text: t("fallback") }),
        p.receiptUrl && h("p", {}, link(p.receiptUrl, "fallback-link")),
        h("p", { class: "hint", text: t("notOpened") }),
      ),
    );
    state.pay = null;
  } catch (e) {
    state.error = e instanceof WalletError ? e.message : "Error";
  }
  state.busy = false;
  render();
}

async function scan(): Promise<void> {
  if (stopCamera) return stopCamera();
  const Detector = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!Detector) return;
  const video = document.getElementById("cam") as HTMLVideoElement;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
  const det = new Detector({ formats: ["qr_code"] });
  let on = true;
  stopCamera = () => {
    on = false;
    stream.getTracks().forEach((tr) => tr.stop());
    video.hidden = true;
    stopCamera = null;
    render();
  };
  render();
  while (on) {
    const codes = await det.detect(video).catch(() => []);
    if (codes[0]) {
      state.input = codes[0].rawValue;
      stopCamera?.();
      return read();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function render(): void {
  const input = h("textarea", { id: "lnurl", "aria-label": t("input"), autocomplete: "off", spellcheck: "false" }) as HTMLTextAreaElement;
  input.value = state.input;
  input.addEventListener("input", () => (state.input = input.value));
  const hasCamera = "BarcodeDetector" in globalThis && !!navigator.mediaDevices?.getUserMedia;
  document.getElementById("app")!.replaceChildren(
    h("div", { class: "sb", id: "sandbox", role: "note", text: t("banner") }),
    h("header", { class: "top" }, h("span", { class: "wm", text: "jaay sim" }), h("button", { class: "chip", id: "lang", text: t("lang"), onclick: () => (toggleLang(), render()) })),
    h(
      "main",
      { id: "view" },
      h("h1", { text: t("title") }),
      h("p", { class: "hint", text: t("hint") }),
      input,
      h("button", { class: "btn secondary", id: "read", text: t("read"), onclick: () => void read() }),
      hasCamera && h("button", { class: "btn secondary", id: "scan", text: stopCamera ? t("stopScan") : t("scan"), onclick: () => void scan() }),
      h("video", { id: "cam", playsinline: "", muted: "", hidden: stopCamera ? undefined : "" }),
      ...state.steps,
      state.pay && h("button", { class: "btn", id: "pay", text: t("pay"), onclick: () => void pay() }),
      state.error && h("p", { class: "msg err", id: "error", role: "alert", text: t("error", { reason: state.error }) }),
      state.raw.length > 0 &&
        h("details", { id: "raw" }, h("summary", { text: t("raw") }), ...state.raw.map((r) => h("div", {}, h("p", { class: "hint", text: r.label }), h("pre", { text: JSON.stringify(r.body, null, 2) })))),
    ),
  );
}

document.documentElement.lang = initLang(navigator.language);
// /sim/?lnurl=... fills the input and reads the payment request; paying always needs a tap.
const fromUrl = new URLSearchParams(location.search).get("lnurl");
if (fromUrl) {
  state.input = fromUrl;
  history.replaceState(null, "", location.pathname);
  void read();
} else render();
