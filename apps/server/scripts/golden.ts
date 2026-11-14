// Golden path against a running SANDBOX server, through real HTTP, acting as the merchant device and the wallet.
// Usage: tsx scripts/golden.ts [baseUrl]   (default http://localhost:8787)
// SANDBOX only: payment is simulated with POST /sandbox/pay/:sid. No real bitcoin.
import { deriveConfirmCode, deriveKeys, encodeSale, secretFromString } from "@jaay/protocol";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const get = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
};
const step = (n: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exit(1);
};

const health = await get(`${base}/healthz`);
step("GET /healthz", health.status === 200, health.text);

const en = await get(`${base}/api/enroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: "Golden Path", backend: "sandbox", connection: "", minXof: 50, maxXof: 5_000_000 }),
});
const { deviceId, deviceSecretB64u } = en.json() as { deviceId: string; deviceSecretB64u: string };
step("POST /api/enroll (sandbox)", en.status === 200 && typeof deviceId === "string", "device secret returned once, not printed");

const keys = await deriveKeys(secretFromString(deviceSecretB64u));
const { token, sid } = await encodeSale(keys, deviceId, { amountXof: 1000 });
step("device encodes sale offline", token.length === 78, "1000 XOF");

const pr = await get(`${base}/lnurlp?p=${encodeURIComponent(token)}`);
const pay = pr.json();
step("GET /lnurlp", pr.status === 200 && pay.tag === "payRequest" && pay.minSendable === pay.maxSendable, `${pay.minSendable} msat`);

const cb = await get(`${pay.callback as string}&amount=${pay.minSendable}`);
const inv = cb.json() as { pr: string; successAction: { url: string } };
step("GET /lnurlp/cb", cb.status === 200 && inv.pr.startsWith("lnbcrt"), "sandbox invoice (zero signature, unpayable by wallets)");

const rt = inv.successAction.url.split("/r/")[1]!;
const before = await get(`${base}/api/receipt/${rt}/status`);
step("receipt before payment has no code", before.status === 200 && before.json().status === "pending" && !("code" in before.json()));

const paid = await get(`${base}/sandbox/pay/${sid}`, { method: "POST" });
step("POST /sandbox/pay/:sid", paid.status === 200, paid.text);

const after = await get(`${base}/api/receipt/${rt}/status`);
const expected = await deriveConfirmCode(keys, sid);
step("receipt after payment shows the protocol-derived code", after.json().status === "paid" && after.json().code === expected);

const html = await get(inv.successAction.url);
step("receipt page", html.status === 200 && html.text.includes(expected) && html.text.includes("SANDBOX"), `${Buffer.byteLength(html.text)} bytes`);

const replay = await get(`${base}/lnurlp?p=${encodeURIComponent(token)}`);
step("replay after paid is refused generically", replay.status === 400 && replay.json().reason === "Invalid or expired sale");
console.log("GOLDEN PATH OK");
