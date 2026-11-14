// Opt-in: the golden path against a REAL Alby Hub NWC connection on the S1 regtest stack. Not part of `pnpm test`.
// Prerequisite (WSL): bash spikes/s1-nwc/scripts/stack.sh, which writes spikes/s1-nwc/.env. Regtest only, no real funds.
// Usage: pnpm --filter @jaay/server test:regtest [--relay-drop]
// Never prints connection strings, macaroons, device secrets or tokens.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import { deriveConfirmCode, deriveKeys, encodeSale, secretFromString } from "@jaay/protocol";
import { REGTEST_ENROLL_TOKEN, testConfigFromEnv } from "./regtest-config";
import { buildServer, listen } from "../src/index";
import { installConsoleGuard } from "../src/log";

const SPIKE = new URL("../../../spikes/s1-nwc/", import.meta.url);
process.loadEnvFile(new URL(".env", SPIKE));
const env = (k: string) => process.env[k] ?? (console.log(`missing ${k}; start the S1 stack first`), process.exit(2));
const NWC_URL = env("NWC_URL");
const LND2 = { rest: env("LND2_REST"), mac: env("LND2_MACAROON_HEX"), ca: readFileSync(new URL(env("LND2_TLS_CERT"), SPIKE)) };
const PORT = 8790;

const out: string[] = [];
const s = buildServer(testConfigFromEnv(PORT), { logSink: (l) => out.push(l) });
const restore = installConsoleGuard(s.log);
const say = (...a: unknown[]) => process.stdout.write(`${a.join(" ")}\n`);
const step = (n: string, ok: boolean, d = "") => {
  say(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`);
  if (!ok) finish(1);
};
const server = listen(s.app.fetch, PORT, "127.0.0.1");
function finish(code: number): never {
  restore();
  s.close();
  server.close();
  const leaked = [NWC_URL, LND2.mac].some((x) => out.join("\n").includes(x));
  say(`server log lines: ${out.length}, secrets found in logs: ${leaked ? "YES" : "none"}`);
  process.exit(leaked ? 1 : code);
}

function lnd<T>(method: string, path: string, body?: object): Promise<T> {
  const [host, port] = LND2.rest.split(":");
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path, method, ca: LND2.ca, headers: { "Grpc-Metadata-macaroon": LND2.mac } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve(JSON.parse(data.trim().split("\n").pop() ?? "{}") as T));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const B = `http://localhost:${PORT}`;
const getJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  return { status: r.status, j: (await r.json()) as Record<string, unknown> };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sale(keys: Awaited<ReturnType<typeof deriveKeys>>, deviceId: string, amountXof: number) {
  const { token, sid } = await encodeSale(keys, deviceId, { amountXof });
  const t0 = performance.now();
  const pr = await getJson(`${B}/lnurlp?p=${encodeURIComponent(token)}`);
  const cb = pr.status === 200 ? await getJson(`${pr.j.callback as string}&amount=${pr.j.minSendable}`) : pr;
  return { token, sid, pr, cb, ms: Math.round(performance.now() - t0) };
}

await s.fx.poll(); // live Kraken / Coinbase, same as production
s.poller.start(1000);
step("FX rate available", s.fx.status() === "ok");

const en = await getJson(`${B}/api/enroll`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${REGTEST_ENROLL_TOKEN}` },
  body: JSON.stringify({ label: "Regtest Hub", backend: "nwc", connection: NWC_URL, minXof: 50, maxXof: 100000 }),
});
step("enroll real Alby Hub NWC (receive-only check via get_info)", en.status === 200);
const deviceId = en.j.deviceId as string;
const keys = await deriveKeys(secretFromString(en.j.deviceSecretB64u as string));

const a = await sale(keys, deviceId, 1000);
const inv = a.cb.j as { pr: string; successAction: { url: string } };
step("lnurlp + callback create a real regtest invoice", a.cb.status === 200 && inv.pr.startsWith("lnbcrt"), `${a.pr.j.minSendable} msat, ${a.ms} ms`);
const rt = inv.successAction.url.split("/r/")[1]!;
step("receipt before payment: pending, no code", (await getJson(`${B}/api/receipt/${rt}/status`)).j.status === "pending");

const tPay = performance.now();
const pay = await lnd<{ result?: { status: string } }>("POST", "/v2/router/send", { payment_request: inv.pr, timeout_seconds: 30, fee_limit_sat: 10 });
step("payer node pays the invoice", pay.result?.status === "SUCCEEDED");
let st: Record<string, unknown> = {};
for (let i = 0; i < 40; i++) {
  st = (await getJson(`${B}/api/receipt/${rt}/status`)).j;
  if (st.status === "paid") break;
  await sleep(500);
}
step("poller sees settlement, receipt shows the protocol code", st.status === "paid" && st.code === (await deriveConfirmCode(keys, a.sid)), `${Math.round(performance.now() - tPay)} ms after pay`);
const again = await getJson(`${B}/lnurlp?p=${encodeURIComponent(a.token)}`);
step("replay after paid refused", again.status === 400);

if (process.argv.includes("--relay-drop")) {
  const wsl = (cmd: string) => execFileSync("wsl", ["-e", "bash", "-c", cmd], { stdio: "ignore" });
  wsl("pkill -x nak || true");
  const down = await sale(keys, deviceId, 1500);
  step("relay down: callback fails closed fast with the generic error", down.cb.status === 400 && down.ms < 15_000, `${down.ms} ms`);
  wsl("nohup $HOME/jaay-s1/bin/nak serve --hostname 127.0.0.1 --port 10547 >/dev/null 2>&1 & sleep 1");
  let back = down;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    back = await sale(keys, deviceId, 1600 + i);
    if (back.cb.status === 200) break;
  }
  step("relay back: a new client reconnects and make_invoice works again", back.cb.status === 200, `${back.ms} ms`);
}
finish(0);
