import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveConfirmCode, encodeSale } from "@jaay/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { NwcBackend } from "./backends/nwc";
import { hashId, installConsoleGuard, scrub } from "./log";
import { enroll, makeServer, q } from "./testkit";

const NWC_SECRET = "deadbeef".repeat(8);
const NWC_PUBKEY = "c0ffee00".repeat(8);
const CONN = `nostr+walletconnect://${NWC_PUBKEY}?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=${NWC_SECRET}`;

let restore: (() => void) | undefined;
afterEach(() => restore?.());

async function fullFlow(dbPath = ":memory:") {
  const srv = makeServer({ cfg: { sandbox: false, dbPath } });
  restore = installConsoleGuard(srv.log);
  srv.nwc.leak = CONN; // a misbehaving library that puts the connection string in errors and console output
  await srv.fx.poll();
  const dev = await enroll(srv, { backend: "nwc", connection: CONN });
  const { token, sid } = await encodeSale(dev.keys, dev.deviceId, { amountXof: 1000 });
  const errors: string[] = [];
  const keep = async (r: Response) => {
    const text = await r.text();
    if (r.status >= 400) errors.push(text);
    return text;
  };

  const pay = JSON.parse(await keep(await srv.req(`/lnurlp?p=${q(token)}`))) as { callback: string; minSendable: number };
  await keep(await srv.req(`/lnurlp?p=${q(token.slice(0, -2))}xx`)); // a failed verification
  await keep(await srv.req(`${pay.callback.slice("http://localhost:8787".length)}&amount=${pay.minSendable + 1000}`));
  const cb = JSON.parse(await keep(await srv.req(`${pay.callback.slice("http://localhost:8787".length)}&amount=${pay.minSendable}`))) as {
    pr: string;
    successAction: { url: string };
  };
  const rt = cb.successAction.url.split("/r/")[1]!;

  // Relay trouble while polling: library errors and console output carry the secrets.
  srv.nwc.mode = "down";
  srv.clock.advance(2000);
  await srv.poller.tick();
  srv.nwc.mode = "ok";
  srv.nwc.settleAll();
  srv.clock.advance(60_000);
  await srv.poller.tick();
  const html = await keep(await srv.req(`/r/${rt}`));
  const code = await deriveConfirmCode(dev.keys, sid);
  expect(html).toContain(code); // the flow really reached the paid receipt

  // A backend error thrown directly, as callers would see it.
  srv.nwc.mode = "down";
  const thrown = await new NwcBackend(CONN, srv.nwc.factory, srv.clock.now, 100).makeInvoice({ msat: 1000n, descriptionHashHex: "00".repeat(32), expirySec: 60 }).catch((e: Error) => e);
  errors.push(String(thrown), String((thrown as Error).stack));

  return { srv, dev, token, sid, rt, code, invoice: cb.pr, errors };
}

describe("log scrubber (security item 6, Hard rule 8)", () => {
  test("a full flow with sentinel secrets leaves none of them in logs or errors; device ids appear only hashed", async () => {
    const f = await fullFlow();
    f.srv.close();
    const logs = f.srv.logs.join("\n");
    expect(logs).toContain("lib_console"); // the guard really captured library console output
    expect(logs).toContain(hashId(f.dev.deviceId));
    const sentinels: Record<string, string> = {
      "NWC connection string": CONN,
      "NWC secret": NWC_SECRET,
      "device secret": f.dev.secret,
      "device id": f.dev.deviceId,
      "sale token": f.token,
      sid: f.sid,
      "receipt token": f.rt,
      "confirm code": f.code,
      invoice: f.invoice,
    };
    for (const [name, value] of Object.entries(sentinels)) {
      expect.soft(logs.includes(value), `${name} in logs`).toBe(false);
      for (const e of f.errors) expect.soft(e.includes(value), `${name} in an error`).toBe(false);
    }
    for (const line of f.srv.logs) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("scrub() removes connection strings, invoices, URLs and long tokens", () => {
    const s = scrub(`x ${CONN} lnbcrt24460n1pjqqqqqqqqqqqqq https://a.b/r/AbCdEfGhIjKlMnOpQrStUv AbCdEfGhIjKlMnOpQrStUv`);
    expect(s).not.toMatch(/walletconnect|deadbeef|lnbcrt24|AbCdEfGh/);
  });

  test("console guard keeps only a scrubbed first string, never objects", () => {
    const lines: string[] = [];
    const srv = makeServer({ edges: { logSink: (l) => lines.push(l) } });
    restore = installConsoleGuard(srv.log);
    console.error(`Failed to request make_invoice ${CONN}`, { secret: NWC_SECRET });
    console.log({ secret: NWC_SECRET });
    restore();
    restore = undefined;
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(NWC_SECRET);
  });
});

describe("no plaintext secrets in the SQLite file (security item 11)", () => {
  // The confirm code is never stored (it is recomputed from the sid), so it is not searched for here.
  test("connection string, device secret, receipt token and sale token are absent from the db bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jaay-db-"));
    const f = await fullFlow(join(dir, "jaay.sqlite"));
    f.srv.close();
    const bytes = Buffer.concat(readdirSync(dir).map((n) => readFileSync(join(dir, n))));
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.includes("v1.")).toBe(true); // sealed values are there
    for (const [name, value] of Object.entries({ CONN, NWC_SECRET, deviceSecret: f.dev.secret, receiptToken: f.rt, token: f.token })) {
      expect.soft(bytes.includes(value), name).toBe(false);
    }
  });
});
