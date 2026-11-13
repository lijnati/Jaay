import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { deriveConfirmCode, encodeSale, type DeviceKeys, type LimitOptions, type Sale } from "@jaay/protocol";
import { decodeSale } from "@jaay/protocol";
import { describe, expect, test } from "vitest";
import { GENERIC_LNURL_ERROR, LNURL_ERROR_STATUS } from "./app";
import { listen } from "./index";
import { RECEIPT_CSP } from "./receipt";
import { createSealer } from "./seal";
import { EXPIRY_GRACE_MS, INVOICE_EXPIRY_SEC, SALE_WINDOW_MS } from "./sales";
import { enroll, makeServer, MASTER_KEY, q, sell, type Device } from "./testkit";

type Srv = ReturnType<typeof makeServer>;
const BASE = "http://localhost:8787";
const path = (url: string) => url.slice(BASE.length);

async function ready(over: Parameters<typeof makeServer>[0] = {}) {
  const srv = makeServer(over);
  await srv.fx.poll();
  return srv;
}

async function payRequest(srv: Srv, token: string) {
  const res = await srv.req(`/lnurlp?p=${q(token)}`);
  return { res, j: (await res.json()) as Record<string, unknown> };
}

async function invoiceFor(srv: Srv, token: string) {
  const { j } = await payRequest(srv, token);
  const res = await srv.req(`${path(j.callback as string)}&amount=${j.minSendable}`);
  return { pay: j, res, cb: (await res.json()) as { pr: string; successAction: { tag: string; url: string; description: string } } };
}

const receiptToken = (srv: Srv, dev: Device, sid: string) => {
  const row = srv.repo.getSale(dev.deviceId, sid)!;
  return createSealer(MASTER_KEY).open(row.receiptSealed, `receipt:${dev.deviceId}:${sid}`);
};

async function snapshot(res: Response) {
  const headers: string[] = [];
  res.headers.forEach((v, k) => headers.push(`${k}: ${v}`));
  return { status: res.status, headers: headers.sort().join("\n"), body: await res.text() };
}

describe("golden path (sandbox, through HTTP)", () => {
  test("enroll, sell offline, LNURL request, callback, pay, receipt shows the protocol-derived code", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const { token, sid } = await sell(dev, 1000);

    const { res, j } = await payRequest(srv, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(j).toMatchObject({ tag: "payRequest", minSendable: 2_446_000, maxSendable: 2_446_000, commentAllowed: 0, sandbox: true });
    expect(j.callback).toBe(`${BASE}/lnurlp/cb?p=${q(token)}`);
    const meta = JSON.parse(j.metadata as string) as [string, string][];
    const text = meta.find(([t]) => t === "text/plain")![1];
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[SANDBOX]");
    expect(text).toContain("1000 XOF");

    const { cb } = await invoiceFor(srv, token);
    expect(cb.pr).toMatch(/^lnbcrt1sandboxfake/);
    expect(cb.successAction.tag).toBe("url");
    expect(cb.successAction.description.length).toBeGreaterThan(0);
    expect(new URL(cb.successAction.url).host).toBe(new URL(j.callback as string).host); // Phoenix: same host
    expect(text).toContain(cb.successAction.url); // S5 fallback: receipt URL in the description text
    const rt = cb.successAction.url.split("/r/")[1]!;
    expect(rt).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits

    const code = await deriveConfirmCode(dev.keys, sid);
    const pending = await srv.req(`/r/${rt}`);
    expect(pending.status).toBe(200);
    expect(await pending.text()).not.toContain(code);

    const pay = await srv.req(`/sandbox/pay/${sid}`, { method: "POST" });
    expect(await pay.json()).toEqual({ sandbox: true, status: "paid" });

    const html = await (await srv.req(`/r/${rt}`, { headers: { "accept-language": "en-US" } })).text();
    expect(html).toContain(code);
    expect(html).toContain("1 000 XOF");
    expect(html).toContain("SANDBOX");
    const st = (await (await srv.req(`/api/receipt/${rt}/status`)).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ status: "paid", amountXof: 1000, code, late: false, sandbox: true });
    expect(srv.repo.getSale(dev.deviceId, sid)!.status).toBe("paid");
  });

  test("quote is stored with rate, source and timestamps; amount uses device limits from enrollment", async () => {
    const srv = await ready();
    const dev = await enroll(srv, { minXof: 100, maxXof: 2000 });
    const { token, sid } = await sell(dev, 2000);
    expect((await payRequest(srv, token)).res.status).toBe(200);
    const row = srv.repo.getSale(dev.deviceId, sid)!;
    expect(row).toMatchObject({ status: "quoted", quoteSource: "kraken", quoteRateMicro: 62_347_800_000n, quotedAt: srv.clock.t, quoteFetchedAt: srv.clock.t });
    expect(row.quoteExpiresAt! - row.quotedAt!).toBe(120_000);
    const over = await sell(dev, 2001);
    expect((await payRequest(srv, over.token)).res.status).toBe(LNURL_ERROR_STATUS);
  });
});

describe("security item 1: every verification failure is the same generic LNURL error", () => {
  test("table of failures, identical status, headers and body", async () => {
    const srv = await ready();
    const other = await ready();
    const dev = await enroll(srv, { minXof: 100, maxXof: 5000 });
    const stranger = await enroll(other);

    const paid = await sell(dev, 1000);
    await invoiceFor(srv, paid.token);
    await srv.req(`/sandbox/pay/${paid.sid}`, { method: "POST" });

    const tampered = (() => {
      const t = paid.token.split("");
      t[40] = t[40] === "A" ? "B" : "A";
      return t.join("");
    })();
    const expiredSale = await sell(dev, 1000);
    srv.fxApi.kraken = null;
    srv.fxApi.coinbase = null; // first scan records the sale but cannot quote
    await payRequest(srv, expiredSale.token);
    srv.fxApi.kraken = "62347.80000";
    srv.fxApi.coinbase = "62350.00";

    const lock = await sell(dev, 1000);
    const lockPay = (await payRequest(srv, lock.token)).j;

    const cases: [string, () => Promise<Response>][] = [
      ["garbage token", () => srv.req("/lnurlp?p=garbage")],
      ["missing token", () => srv.req("/lnurlp")],
      ["tampered token", () => srv.req(`/lnurlp?p=${q(tampered)}`)],
      ["unknown device", async () => srv.req(`/lnurlp?p=${q((await sell(stranger, 1000)).token)}`)],
      ["above device max", async () => srv.req(`/lnurlp?p=${q((await sell(dev, 5001)).token)}`)],
      ["below device min", async () => srv.req(`/lnurlp?p=${q((await sell(dev, 99)).token)}`)],
      ["replayed after paid", () => srv.req(`/lnurlp?p=${q(paid.token)}`)],
      ["callback after paid", () => srv.req(`/lnurlp/cb?p=${q(paid.token)}&amount=2446000`)],
      ["callback without a quote", async () => srv.req(`/lnurlp/cb?p=${q((await sell(dev, 1234)).token)}&amount=2446000`)],
      ["callback amount one msat low", () => srv.req(`${path(lockPay.callback as string)}&amount=${(lockPay.minSendable as number) - 1}`)],
      ["callback amount one msat high", () => srv.req(`${path(lockPay.callback as string)}&amount=${(lockPay.minSendable as number) + 1}`)],
      ["callback amount not a number", () => srv.req(`${path(lockPay.callback as string)}&amount=abc`)],
      ["callback amount leading zero", () => srv.req(`${path(lockPay.callback as string)}&amount=0${lockPay.minSendable}`)],
      ["callback amount missing", () => srv.req(path(lockPay.callback as string))],
      [
        "sale window expired",
        async () => {
          srv.clock.advance(SALE_WINDOW_MS + 1);
          return srv.req(`/lnurlp?p=${q(expiredSale.token)}`);
        },
      ],
      ["callback after the quote lock", () => srv.req(`${path(lockPay.callback as string)}&amount=${lockPay.minSendable}`)],
    ];
    const snaps = [];
    for (const [name, run] of cases) {
      const s = await snapshot(await run());
      snaps.push({ name, ...s });
    }
    const want = JSON.stringify({ ...GENERIC_LNURL_ERROR, sandbox: true });
    for (const s of snaps) {
      expect.soft(s.status, s.name).toBe(LNURL_ERROR_STATUS);
      expect.soft(s.body, s.name).toBe(want);
      expect.soft(s.headers, s.name).toBe(snaps[0]!.headers);
    }
  });

  test("unknown devices still run a full decrypt (same timing path)", async () => {
    let decodes = 0;
    const spy = (t: string, k: DeviceKeys, o: LimitOptions): Promise<Sale> => {
      decodes++;
      return decodeSale(t, k, o);
    };
    const srv = await ready({ edges: { decode: spy } });
    const other = await ready();
    const stranger = await enroll(other);
    const res = await srv.req(`/lnurlp?p=${q((await sell(stranger, 1000)).token)}`);
    expect(res.status).toBe(LNURL_ERROR_STATUS);
    expect(decodes).toBe(1);
  });
});

describe("security items 2 and 3: exact amount, idempotency, replay", () => {
  test("a pending sid returns the same invoice and receipt; a paid sid never invoices again", async () => {
    const srv = await ready({ cfg: { allowMixed: true } });
    const dev = await enroll(srv);
    const { token, sid } = await sell(dev, 1000);
    const a = await invoiceFor(srv, token);
    const b = await invoiceFor(srv, token);
    expect(b.cb.pr).toBe(a.cb.pr);
    expect(b.cb.successAction.url).toBe(a.cb.successAction.url);
    expect(b.pay.metadata).toBe(a.pay.metadata);
    // Concurrent duplicate callbacks still produce one invoice.
    const cbs = await Promise.all(Array.from({ length: 5 }, () => srv.req(`${path(a.pay.callback as string)}&amount=${a.pay.minSendable}`)));
    const prs = new Set(await Promise.all(cbs.map(async (r) => ((await r.json()) as { pr: string }).pr)));
    expect([...prs]).toEqual([a.cb.pr]);

    await srv.req(`/sandbox/pay/${sid}`, { method: "POST" });
    expect((await payRequest(srv, token)).res.status).toBe(LNURL_ERROR_STATUS);
    const again = await srv.req(`${path(a.pay.callback as string)}&amount=${a.pay.minSendable}`);
    expect(again.status).toBe(LNURL_ERROR_STATUS);
    expect((await srv.req(`/sandbox/pay/${sid}`, { method: "POST" })).status).toBe(404);
  });

  test("concurrent first scans of one sid create one sale and one quote", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const { token } = await sell(dev, 1000);
    const rs = await Promise.all(Array.from({ length: 5 }, () => payRequest(srv, token)));
    expect(new Set(rs.map((r) => r.j.metadata)).size).toBe(1);
  });
});

describe("security item 4: receipt gating over every status", () => {
  async function reachEveryStatus() {
    const srv = await ready();
    const dev = await enroll(srv);
    const out: { status: string; rt: string; code: string }[] = [];
    const add = async (status: string, sid: string) => out.push({ status, rt: receiptToken(srv, dev, sid), code: await deriveConfirmCode(dev.keys, sid) });

    // created: no usable rate on first scan (sources diverge)
    srv.fxApi.coinbase = "70000";
    await srv.fx.poll();
    const created = await sell(dev, 1000);
    await payRequest(srv, created.token);
    srv.fxApi.coinbase = "62350.00";
    await srv.fx.poll();
    // quoted
    const quoted = await sell(dev, 1000);
    await payRequest(srv, quoted.token);
    // paid
    const paid = await sell(dev, 1000);
    await invoiceFor(srv, paid.token);
    await srv.req(`/sandbox/pay/${paid.sid}`, { method: "POST" });
    // expired and paid_late: invoice passes expiry unpaid, then one of them is paid late
    const expired = await sell(dev, 1000);
    const late = await sell(dev, 1000);
    await invoiceFor(srv, expired.token);
    await invoiceFor(srv, late.token);
    srv.clock.advance(INVOICE_EXPIRY_SEC * 1000 + EXPIRY_GRACE_MS + 1);
    await srv.poller.tick();
    expect(srv.repo.getSale(dev.deviceId, late.sid)!.status).toBe("expired");
    srv.sandbox!.markPaid(srv.repo.getSale(dev.deviceId, late.sid)!.paymentHash!);
    srv.clock.advance(5 * 60_000);
    await srv.poller.tick();
    // invoiced: created after the time jump so it is still open (the rate is stale by now, so poll again)
    await srv.fx.poll();
    const invoiced = await sell(dev, 1000);
    await invoiceFor(srv, invoiced.token);

    for (const [status, s] of [["created", created], ["quoted", quoted], ["invoiced", invoiced], ["paid", paid], ["expired", expired], ["paid_late", late]] as const) {
      expect(srv.repo.getSale(dev.deviceId, s.sid)!.status).toBe(status);
      await add(status, s.sid);
    }
    return { srv, out };
  }

  test("the code appears only for paid and paid_late, in HTML, JSON and headers", async () => {
    const { srv, out } = await reachEveryStatus();
    for (const { status, rt, code } of out) {
      for (const p of [`/r/${rt}`, `/api/receipt/${rt}/status`]) {
        const s = await snapshot(await srv.req(p));
        const all = `${s.headers}\n${s.body}`;
        const settled = status === "paid" || status === "paid_late";
        expect.soft(all.includes(code), `${status} ${p}`).toBe(settled);
        if (!settled) expect.soft(/"code"/.test(s.body), `${status} ${p}`).toBe(false);
      }
    }
    const late = out.find((o) => o.status === "paid_late")!;
    expect(await (await srv.req(`/api/receipt/${late.rt}/status`)).json()).toMatchObject({ status: "paid", late: true });
  });

  test("unknown, malformed and expired-unpaid receipt tokens get an identical response", async () => {
    const { srv, out } = await reachEveryStatus();
    const expired = out.find((o) => o.status === "expired")!.rt;
    for (const p of ["/r/", "/api/receipt/"]) {
      const suffix = p === "/r/" ? "" : "/status";
      const snaps = await Promise.all(
        [expired, "A".repeat(22), "not-a-token", "x".repeat(300)].map(async (rt) => snapshot(await srv.req(`${p}${rt}${suffix}`))),
      );
      for (const s of snaps) expect(s).toEqual(snaps[0]);
      expect(snaps[0]!.status).toBe(404);
    }
  });

  test("receipt page is under 15 KB, needs no JavaScript, carries a strict CSP", async () => {
    const { srv, out } = await reachEveryStatus();
    for (const { rt } of out) {
      const res = await srv.req(`/r/${rt}`);
      const body = await res.text();
      expect(Buffer.byteLength(body)).toBeLessThan(15 * 1024);
      expect(body).not.toMatch(/<script/i);
      expect(res.headers.get("content-security-policy")).toBe(RECEIPT_CSP);
      expect(RECEIPT_CSP).toContain("default-src 'none'");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("French by default, English via Accept-Language", async () => {
    const { srv, out } = await reachEveryStatus();
    const rt = out.find((o) => o.status === "invoiced")!.rt;
    expect(await (await srv.req(`/r/${rt}`)).text()).toContain("Pas encore paye");
    expect(await (await srv.req(`/r/${rt}`, { headers: { "accept-language": "en-GB,en;q=0.9" } })).text()).toContain("Not paid yet");
  });
});

describe("settlement poller", () => {
  test("detects payment with nobody opening the receipt, and backs off while pending", async () => {
    const srv = await ready();
    const dev = await enroll(srv);
    const { token, sid } = await sell(dev, 1000);
    await invoiceFor(srv, token);
    const first = srv.repo.getSale(dev.deviceId, sid)!.nextCheckAt!;
    srv.clock.advance(2000);
    await srv.poller.tick();
    const second = srv.repo.getSale(dev.deviceId, sid)!.nextCheckAt!;
    expect(second - srv.clock.t).toBeGreaterThan(first - (srv.clock.t - 2000));
    srv.sandbox!.markPaid(srv.repo.getSale(dev.deviceId, sid)!.paymentHash!);
    srv.clock.advance(60_000);
    await srv.poller.tick();
    expect(srv.repo.getSale(dev.deviceId, sid)!.status).toBe("paid");
  });
});

describe("security items 5 and 7: per-IP rate limits", () => {
  test.each([
    ["lnurlp", (srv: Srv, ip: string) => srv.req("/lnurlp?p=x", { ip })],
    ["cb", (srv: Srv, ip: string) => srv.req("/lnurlp/cb?p=x&amount=1", { ip })],
    ["receipt", (srv: Srv, ip: string) => srv.req(`/r/${"A".repeat(22)}`, { ip })],
    ["receipt", (srv: Srv, ip: string) => srv.req(`/api/receipt/${"A".repeat(22)}/status`, { ip })],
    [
      "enroll",
      (srv: Srv, ip: string) => srv.req("/api/enroll", { ip, method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ],
  ] as const)("%s: limit per IP, other IPs unaffected, window resets", async (bucket, hit) => {
    const srv = await ready({ edges: { limits: { [bucket]: [3, 60_000] } } });
    for (let i = 0; i < 3; i++) expect((await hit(srv, "198.51.100.7")).status).not.toBe(429);
    expect((await hit(srv, "198.51.100.7")).status).toBe(429);
    expect((await hit(srv, "198.51.100.8")).status).not.toBe(429);
    srv.clock.advance(60_000);
    expect((await hit(srv, "198.51.100.7")).status).not.toBe(429);
  });

  test("a 429 on the receipt page carries no code", async () => {
    const srv = await ready({ edges: { limits: { receipt: [1, 60_000] } } });
    await srv.req(`/r/${"A".repeat(22)}`);
    const res = await srv.req(`/r/${"A".repeat(22)}`);
    expect(res.status).toBe(429);
    expect(await res.text()).not.toMatch(/\b\d{6}\b/);
  });
});

describe("security item 8: size limits, CORS, headers", () => {
  test("token over 256 chars is rejected before decode", async () => {
    let decodes = 0;
    const srv = await ready({
      edges: {
        decode: (t, k, o) => {
          decodes++;
          return decodeSale(t, k, o);
        },
      },
    });
    const dev = await enroll(srv);
    const { token } = await sell(dev, 1000);
    const res = await srv.req(`/lnurlp?p=${q(token + "A".repeat(257 - token.length))}`);
    expect(res.status).toBe(LNURL_ERROR_STATUS);
    expect(decodes).toBe(0);
  });

  test("URL over 2048 chars gets 414; enroll body over 4 KB gets 413", async () => {
    const srv = await ready();
    expect((await srv.req(`/lnurlp?p=${"A".repeat(2100)}`)).status).toBe(414);
    const big = JSON.stringify({ label: "x", backend: "sandbox", connection: "y".repeat(5000), minXof: 1, maxXof: 2 });
    expect((await srv.req("/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: big })).status).toBe(413);
  });

  test("request headers over 8 KB are refused by the Node server (431)", async () => {
    const srv = await ready();
    const server = listen(srv.app.fetch, 0, "127.0.0.1") as http.Server;
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.get({ host: "127.0.0.1", port, path: "/healthz", headers: { "x-big": "a".repeat(9000) } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      r.on("error", reject);
    });
    server.close();
    expect(status).toBe(431);
  });

  test("CORS: LNURL endpoints allow any origin; the enroll API does not", async () => {
    const srv = await ready();
    expect((await srv.req("/lnurlp?p=x")).headers.get("access-control-allow-origin")).toBe("*");
    const pre = await srv.req("/lnurlp/cb", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const enr = await srv.req("/api/enroll", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(enr.headers.get("access-control-allow-origin")).toBeNull();
    expect((await srv.req("/api/enroll", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("security headers on every response; healthz reveals no versions", async () => {
    const srv = await ready();
    for (const p of ["/healthz", "/lnurlp?p=x", `/r/${"A".repeat(22)}`, "/nope"]) {
      const res = await srv.req(p);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
    expect(await (await srv.req("/healthz")).json()).toEqual({ status: "ok", fx: "ok", sandbox: true });
  });
});

describe("enrollment", () => {
  test("returns device id and secret once; invalid bodies get one generic answer", async () => {
    const srv = await ready();
    const ok = await srv.req("/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Boutique Awa", backend: "sandbox", connection: "", minXof: 50, maxXof: 100000 }),
    });
    const j = (await ok.json()) as Record<string, string>;
    expect(j.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(j.deviceSecretB64u).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(j.baseUrl).toBe(BASE);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const bads = [
      "not json",
      JSON.stringify({ label: "", backend: "sandbox", connection: "", minXof: 1, maxXof: 2 }),
      JSON.stringify({ label: "x<script>", backend: "sandbox", connection: "", minXof: 1, maxXof: 2 }),
      JSON.stringify({ label: "x", backend: "cash", connection: "", minXof: 1, maxXof: 2 }),
      JSON.stringify({ label: "x", backend: "sandbox", connection: "", minXof: 5, maxXof: 2 }),
      JSON.stringify({ label: "x", backend: "sandbox", connection: "", minXof: 0, maxXof: 2 }),
      JSON.stringify({ label: "x", backend: "sandbox", connection: "", minXof: 1, maxXof: 2 ** 32 }),
      JSON.stringify({ label: "x", backend: "sandbox", connection: "", minXof: 1.5, maxXof: 2 }),
      JSON.stringify({ label: "x", backend: "nwc", connection: "nostr+walletconnect://x", minXof: 1, maxXof: 2 }),
    ];
    for (const body of bads) {
      const r = await srv.req("/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "enrollment rejected", sandbox: true });
    }
  });

  test("a non-sandbox server has no sandbox routes or labels and refuses sandbox devices", async () => {
    const srv = await ready({ cfg: { sandbox: false } });
    expect((await srv.req("/sandbox/pay/abc", { method: "POST" })).status).toBe(404);
    const r = await srv.req("/healthz");
    expect(r.headers.get("x-jaay-sandbox")).toBeNull();
    expect(await r.json()).toEqual({ status: "ok", fx: "ok" });
    const e = await srv.req("/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x", backend: "sandbox", connection: "", minXof: 1, maxXof: 2 }),
    });
    expect(e.status).toBe(400);
  });
});

describe("NWC backend through HTTP (fake wallet)", () => {
  test("invoice carries description_hash = sha256(metadata), amount and expiry; lookup settles", async () => {
    const srv = await ready({ cfg: { sandbox: false } });
    const conn = `nostr+walletconnect://${"1".repeat(64)}?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=${"2".repeat(64)}`;
    const dev = await enroll(srv, { backend: "nwc", connection: conn });
    const { token, sid } = await encodeSale(dev.keys, dev.deviceId, { amountXof: 1000 });
    const { pay, cb } = await invoiceFor(srv, token);
    const inv = [...srv.nwc.invoices.values()][0]!;
    expect(inv.descriptionHash).toBe(createHash("sha256").update(pay.metadata as string).digest("hex"));
    expect(inv.amount).toBe(pay.minSendable);
    expect(inv.expiry).toBe(INVOICE_EXPIRY_SEC);
    expect(JSON.parse(pay.metadata as string)[0][1]).not.toContain("SANDBOX");
    srv.nwc.settleAll();
    srv.clock.advance(2000); // first settlement check is due 2 s after the invoice
    const rt = cb.successAction.url.split("/r/")[1]!;
    const st = (await (await srv.req(`/api/receipt/${rt}/status`)).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ status: "paid", code: await deriveConfirmCode(dev.keys, sid) });
  });

  test("backend down at callback time fails closed with the generic error", async () => {
    const srv = await ready({ cfg: { sandbox: false } });
    const conn = `nostr+walletconnect://${"1".repeat(64)}?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=${"2".repeat(64)}`;
    const dev = await enroll(srv, { backend: "nwc", connection: conn });
    const { token } = await encodeSale(dev.keys, dev.deviceId, { amountXof: 1000 });
    const { j } = await payRequest(srv, token);
    srv.nwc.mode = "down";
    const res = await srv.req(`${path(j.callback as string)}&amount=${j.minSendable}`);
    expect(res.status).toBe(LNURL_ERROR_STATUS);
    expect(await res.json()).toEqual(GENERIC_LNURL_ERROR);
  });
});
