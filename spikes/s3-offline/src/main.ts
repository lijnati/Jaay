// Spike S3 page. Spike-only test key and base URL; never use in M3.
import {
  buildSaleLnurl,
  decodeSale,
  deriveConfirmCode,
  deriveKeys,
  encodeSale,
  secretFromString,
  toQrString,
  type DeviceKeys,
} from "@jaay/protocol";
import { renderQr } from "qr-impl";
import type { Ecc, QrInfo } from "./qr-common";

declare const __BUILD__: string;
const BASE_URL = "https://pay.jaay.example.sn/v1";
const TEST_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // bytes 0..31, same as protocol vectors
const TEST_DEVICE_ID = "QEFCQ0RFRkdISUpLTE1OTw";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- IndexedDB ----------
const dbp: Promise<IDBDatabase> = new Promise((resolve, reject) => {
  const r = indexedDB.open("jaay-s3", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("sales", { keyPath: "sid" });
    r.result.createObjectStore("keys");
    r.result.createObjectStore("meta");
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

type SaleRec = { sid: string; amountXof: number; createdAt: number; status: "unpaid" | "checked" };
const ledgerCount = () => idb<number>("sales", "readonly", (s) => s.count());
const showLedger = async () => ($("ledger").textContent = String(await ledgerCount()));

// ---------- sale ----------
const keysP: Promise<DeviceKeys> = deriveKeys(secretFromString(TEST_SECRET));
let last: { qrString: string; lnurl: string; info: QrInfo } | null = null;

async function createSale(amountXof: number) {
  const keys = await keysP;
  const { token, sid } = await encodeSale(keys, TEST_DEVICE_ID, { amountXof });
  const lnurl = buildSaleLnurl(BASE_URL, token);
  const qrString = toQrString(lnurl);
  const info = renderQr($("qr"), qrString);
  $("lnurl").textContent = lnurl;
  await idb("sales", "readwrite", (s) => s.put({ sid, amountXof, createdAt: Date.now(), status: "unpaid" } satisfies SaleRec));
  await showLedger();
  last = { qrString, lnurl, info };
  return last;
}

$("f").addEventListener("submit", (e) => {
  e.preventDefault();
  void createSale(Number(($("amount") as HTMLInputElement).value));
});

// ---------- reconcile stub ----------
let reconciles = 0;
window.addEventListener("online", async () => {
  const sales = await idb<SaleRec[]>("sales", "readonly", (s) => s.getAll());
  // Stub: M3 posts these sids to /v1/sales/reconcile. Here we only mark them as checked.
  for (const s of sales) await idb("sales", "readwrite", (st) => st.put({ ...s, status: "checked" }));
  reconciles++;
  $("net").textContent = `online, reconciled ${sales.length}`;
});
window.addEventListener("offline", () => ($("net").textContent = "offline"));

// ---------- non-extractable key persistence (check 3) ----------
async function storeKey() {
  const fresh = await deriveKeys(crypto.getRandomValues(new Uint8Array(32)));
  const { token, sid } = await encodeSale(fresh, TEST_DEVICE_ID, { amountXof: 4242 });
  const code = await deriveConfirmCode(fresh, sid); // test plumbing only, never rendered
  await idb("keys", "readwrite", (s) => s.put(fresh, "device"));
  await idb("meta", "readwrite", (s) => s.put({ token, sid, code }, "keyprobe"));
  return { extractable: [fresh.enc.extractable, fresh.code.extractable, fresh.auth.extractable] };
}
async function useStoredKey() {
  const k = await idb<DeviceKeys | undefined>("keys", "readonly", (s) => s.get("device"));
  const probe = await idb<{ token: string; sid: string; code: string }>("meta", "readonly", (s) => s.get("keyprobe"));
  if (!k) return { persisted: false };
  const isCryptoKey = k.enc instanceof CryptoKey && k.code instanceof CryptoKey && k.auth instanceof CryptoKey;
  const opened = await decodeSale(probe.token, k, {});
  const sameCode = (await deriveConfirmCode(k, probe.sid)) === probe.code;
  const again = await encodeSale(k, TEST_DEVICE_ID, { amountXof: 777 });
  const roundtrip = (await decodeSale(again.token, k, {})).amountXof === 777;
  let exportRejected = false;
  try {
    await crypto.subtle.exportKey("raw", k.enc);
  } catch {
    exportRejected = true;
  }
  return {
    persisted: true,
    isCryptoKey,
    extractable: k.enc.extractable,
    algorithm: k.enc.algorithm.name,
    decodesTokenFromBeforeReload: opened.amountXof === 4242,
    sameConfirmCode: sameCode,
    roundtrip,
    exportRejected,
  };
}

// ---------- service worker, prompt-style update ----------
const hadController = !!navigator.serviceWorker?.controller;
let updateReady = false;
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").then((reg) => {
    const show = () => {
      updateReady = true;
      $("update").hidden = false;
    };
    if (reg.waiting && navigator.serviceWorker.controller) show();
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) show();
      });
    });
    $("apply").addEventListener("click", () => reg.waiting?.postMessage("SKIP_WAITING"));
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) {
      reloading = true;
      location.reload();
    }
  });
}

$("build").textContent = __BUILD__;
$("net").textContent = navigator.onLine ? "online" : "offline";
void showLedger();

// Hooks for the Playwright checks.
Object.assign(window, {
  __s3: {
    build: __BUILD__,
    createSale,
    ledgerCount,
    storeKey,
    useStoredKey,
    reconciles: () => reconciles,
    updateReady: () => updateReady,
    last: () => last,
    qrStats: (text: string, ecc: Ecc) => renderQr(document.createElement("canvas"), text, ecc),
    secure: () => ({ isSecureContext, subtle: typeof crypto.subtle?.encrypt === "function" }),
  },
});
