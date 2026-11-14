// SANDBOX demo helpers. Everything here refuses to run unless the device config says sandbox.
import type { DeviceKeys } from "@jaay/protocol";
import { b64uEncode, devicePost } from "./auth";
import { allSales, deleteSale, putSale, type DeviceConfig, type SaleRec } from "./db";

export const DEMO_LABELS = ["Boutique alimentaire", "Atelier de couture", "Jus de bissap"] as const;
// Realistic West African prices in XOF (500 to 25 000 F), hours before "now", merchant type index.
const PLAN: [number, number, number][] = [
  [1500, 2, 0], [500, 5, 2], [12000, 9, 1], [750, 14, 2], [3500, 20, 0], [25000, 26, 1],
  [1000, 31, 2], [6500, 38, 0], [18000, 45, 1], [2000, 52, 0], [600, 60, 2], [9500, 68, 1],
];

/** Sandbox only: what the Sell screen offers under the QR. Null in any other mode. */
export function sandboxHelpers(config: DeviceConfig, qr: string): { copy: string; simUrl: string } | null {
  if (!config.sandbox) return null;
  return { copy: qr, simUrl: `/sim/?lnurl=${encodeURIComponent(qr)}` };
}

/** Deterministic per device, so loading twice creates nothing new (same sids). */
export async function demoSales(deviceId: string, now: number): Promise<SaleRec[]> {
  return Promise.all(
    PLAN.map(async ([amountXof, hoursAgo, type], i) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`jaay-demo|${deviceId}|${i}`));
      const createdAt = now - hoursAgo * 3_600_000;
      return {
        sid: b64uEncode(new Uint8Array(digest).slice(0, 8)),
        amountXof,
        createdAt,
        windowEndsAt: createdAt + 15 * 60_000,
        // Inserted as paid demo history (not a transition: the sale is created in this state, flagged demo).
        status: "paid",
        attempts: 0,
        qr: "",
        demo: true,
        demoLabel: DEMO_LABELS[type],
        server: { status: "paid", amountXof, settledAt: new Date(createdAt + 60_000).toISOString(), mismatch: false, at: now },
      } satisfies SaleRec;
    }),
  );
}

type Ctx = { fetchFn: typeof fetch; config: DeviceConfig; keys: DeviceKeys; now: number };

/** Seeds the server first (signed), then the local ledger, so both show the same history. */
export async function loadDemo(c: Ctx): Promise<number> {
  if (!c.config.sandbox) throw new Error("sandbox only");
  const sales = await demoSales(c.config.deviceId, c.now);
  const body = { sales: sales.map((s) => ({ sid: s.sid, amountXof: s.amountXof, paidAt: s.createdAt + 60_000 })) };
  await devicePost(c.fetchFn, c.config.baseUrl, c.config.deviceId, c.keys.auth, "/sandbox/seed", body, c.now);
  for (const s of sales) await putSale(s);
  return sales.length;
}

/** One tap: removes demo sales on the server and in the local ledger; real sandbox sales stay. */
export async function removeDemo(c: Ctx): Promise<number> {
  if (!c.config.sandbox) throw new Error("sandbox only");
  await devicePost(c.fetchFn, c.config.baseUrl, c.config.deviceId, c.keys.auth, "/sandbox/unseed", {}, c.now);
  const demo = (await allSales()).filter((s) => s.demo);
  for (const s of demo) await deleteSale(s.sid);
  return demo.length;
}
