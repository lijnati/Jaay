import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createSealer } from "../seal";
import { ALBY_HUB_METHODS, Clock, FakeNwcWallet, MASTER_KEY } from "../testkit";
import { Backends } from "./index";
import { LnbitsBackend, parseLnbitsConnection } from "./lnbits";
import { NwcBackend, nwcInfoAcceptable } from "./nwc";
import { SandboxBackend } from "./sandbox";
import { BackendUnavailable, isTestNetworkInvoice } from "./types";

const DH = "ab".repeat(32);
const NWC_URL = `nostr+walletconnect://${"1".repeat(64)}?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=${"2".repeat(64)}`;

describe("mainnet guard (Hard rule 1)", () => {
  test.each([
    ["lnbcrt24460n1pjqqqqqqqqqqqqqqqqqqqqqq", true],
    ["lntbs10u1pjqqqqqqqqqqqqqqqqqqqqqqqq", true],
    ["lntb1pjqqqqqqqqqqqqqqqqqqqqqqqqqqqq", true],
    ["lnbc24460n1pjqqqqqqqqqqqqqqqqqqqqqq", false],
    ["lnbc1pjqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", false],
    ["LNBC24460N1PJQQQQQQQQQQQQQQQQQQQQQQ", false],
    ["", false],
  ])("%s -> %s", (pr, ok) => expect(isTestNetworkInvoice(pr)).toBe(ok));
});

describe("sandbox backend", () => {
  test("fake invoices settle only via markPaid", async () => {
    const clock = new Clock();
    const b = new SandboxBackend(clock.now);
    const inv = await b.makeInvoice({ msat: 1000n, descriptionHashHex: DH, expirySec: 600 });
    expect(inv.invoice).toMatch(/^lnbcrt10n1[02-9ac-hj-np-z]+$/); // real BOLT11 layout, zero signature
    expect(inv.expiresAt).toBe(clock.t + 600_000);
    expect(await b.lookupInvoice(inv.paymentHash)).toEqual({ state: "pending" });
    expect(b.markPaid("0".repeat(64))).toBe(false);
    expect(b.markPaid(inv.paymentHash)).toBe(true);
    expect(await b.lookupInvoice(inv.paymentHash)).toEqual({ state: "settled" });
  });
});

describe("lnbits backend (mocked HTTP server; a real LNbits was NOT RUN)", () => {
  const KEY = "c".repeat(32);
  let server: http.Server;
  let base = "";
  const seen: { method: string; url: string; key?: string; body: string }[] = [];
  let paid = false;
  let invoicePrefix = "lnbcrt";
  let fail = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, key: req.headers["x-api-key"] as string, body });
        res.setHeader("content-type", "application/json");
        if (fail || req.headers["x-api-key"] !== KEY) return void res.writeHead(401).end('{"detail":"Invalid key"}');
        if (req.url === "/api/v1/wallet") return void res.end('{"name":"w","balance":0}');
        if (req.method === "POST" && req.url === "/api/v1/payments")
          return void res.end(JSON.stringify({ payment_hash: "d".repeat(64), bolt11: `${invoicePrefix}25u1pjqqqqqqqqqqqqqqqqqqqqqqqq` }));
        if (req.url === `/api/v1/payments/${"d".repeat(64)}`) return void res.end(JSON.stringify({ paid }));
        res.writeHead(404).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  test("connection string parsing: https or localhost http, 32-hex key, key stripped from the URL", () => {
    expect(parseLnbitsConnection(`https://lnbits.example/?api-key=${KEY}`)).toEqual({ url: "https://lnbits.example", key: KEY });
    expect(parseLnbitsConnection(`http://lnbits.example/?api-key=${KEY}`)).toBeNull();
    expect(parseLnbitsConnection(`https://lnbits.example/?api-key=short`)).toBeNull();
    expect(parseLnbitsConnection("not a url")).toBeNull();
  });

  test("make invoice sends whole sats, description_hash and expiry; lookup maps paid", async () => {
    const clock = new Clock();
    const b = new LnbitsBackend({ url: base, key: KEY }, fetch, clock.now, 30_000); // real loopback HTTP: a generous bound so a loaded machine cannot trip the timeout
    await b.check();
    const inv = await b.makeInvoice({ msat: 2_446_000n, descriptionHashHex: DH, expirySec: 600 });
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.key).toBe(KEY);
    expect(JSON.parse(post.body)).toMatchObject({ out: false, amount: 2446, description_hash: DH, expiry: 600 });
    expect(inv.paymentHash).toBe("d".repeat(64));
    expect(await b.lookupInvoice(inv.paymentHash)).toEqual({ state: "pending" });
    paid = true;
    expect(await b.lookupInvoice(inv.paymentHash)).toEqual({ state: "settled" });
  });

  test("fails closed: bad key, server error, non-whole-sat amount, mainnet invoice", async () => {
    const clock = new Clock();
    await expect(new LnbitsBackend({ url: base, key: "e".repeat(32) }, fetch, clock.now, 30_000).check()).rejects.toBeInstanceOf(BackendUnavailable);
    const b = new LnbitsBackend({ url: base, key: KEY }, fetch, clock.now, 30_000);
    await expect(b.makeInvoice({ msat: 1500n, descriptionHashHex: DH, expirySec: 600 })).rejects.toBeInstanceOf(BackendUnavailable);
    invoicePrefix = "lnbc";
    await expect(b.makeInvoice({ msat: 1000n, descriptionHashHex: DH, expirySec: 600 })).rejects.toBeInstanceOf(BackendUnavailable);
    invoicePrefix = "lnbcrt";
    fail = true;
    await expect(b.lookupInvoice("d".repeat(64))).rejects.toBeInstanceOf(BackendUnavailable);
    fail = false;
  });
});

describe("NWC enrollment rule (security item 9)", () => {
  test("Alby Hub's receive-only method list is accepted (extra hold-invoice methods are fine)", () => {
    expect(nwcInfoAcceptable({ methods: ALBY_HUB_METHODS, network: "regtest" })).toBe(true);
    expect(nwcInfoAcceptable({ methods: ["make_invoice", "lookup_invoice"], network: "signet" })).toBe(true);
  });

  test.each([
    ["pay_invoice"],
    ["multi_pay_invoice"],
    ["pay_keysend"],
    ["multi_pay_keysend"],
    ["pay_offer"],
    ["PAY_INVOICE"],
    ["prepay_something"],
  ])("rejects any spend-capable method: %s", (m) => {
    expect(nwcInfoAcceptable({ methods: [...ALBY_HUB_METHODS, m], network: "regtest" })).toBe(false);
  });

  test("requires make_invoice and lookup_invoice, a test network, and well-formed input", () => {
    expect(nwcInfoAcceptable({ methods: ["make_invoice"], network: "regtest" })).toBe(false);
    expect(nwcInfoAcceptable({ methods: ["lookup_invoice"], network: "regtest" })).toBe(false);
    expect(nwcInfoAcceptable({ methods: ALBY_HUB_METHODS, network: "bitcoin" })).toBe(false);
    expect(nwcInfoAcceptable({ methods: ALBY_HUB_METHODS, network: "mainnet" })).toBe(false);
    expect(nwcInfoAcceptable({ methods: ALBY_HUB_METHODS })).toBe(false);
    expect(nwcInfoAcceptable({ methods: "make_invoice,lookup_invoice", network: "regtest" })).toBe(false);
  });

  const registry = (wallet: FakeNwcWallet, sandbox: boolean, allowMixed = false, fetchFn: typeof fetch = fetch) =>
    new Backends({
      sealer: createSealer(MASTER_KEY),
      nwcFactory: wallet.factory,
      fetch: fetchFn,
      now: Date.now,
      sandbox: sandbox ? new SandboxBackend(Date.now) : null,
      allowMixed,
      lnbitsAllowedHosts: ["lnbits.example"],
      nwcAllowedRelays: ["ws://127.0.0.1:10547"],
      timeoutMs: 200,
    });

  test("anti-SSRF: relays and LNbits hosts off the operator allowlist are refused without any network call", async () => {
    const w = new FakeNwcWallet();
    let fetches = 0;
    const countingFetch = (async () => {
      fetches++;
      return Response.json({ name: "w" });
    }) as typeof fetch;
    const r = registry(w, false, false, countingFetch);
    const evilRelay = NWC_URL.replace("ws%3A%2F%2F127.0.0.1%3A10547", "ws%3A%2F%2F10.0.0.5%3A80");
    expect(await r.acceptable("nwc", evilRelay)).toBe(false);
    expect(await r.acceptable("nwc", `${NWC_URL}&relay=wss%3A%2F%2Fevil.example`)).toBe(false); // every relay must be allowed
    expect(await r.acceptable("lnbits", `https://169.254.169.254/?api-key=${"c".repeat(32)}`)).toBe(false);
    expect(await r.acceptable("lnbits", `http://localhost:5000/?api-key=${"c".repeat(32)}`)).toBe(false);
    expect(w.clientsCreated).toBe(0);
    expect(fetches).toBe(0);
    expect(await r.acceptable("lnbits", `https://lnbits.example/?api-key=${"c".repeat(32)}`)).toBe(true);
    expect(fetches).toBe(1);
  });

  test("enrollment through a fake NWC client: receive-only accepted, spend-capable rejected", async () => {
    const w = new FakeNwcWallet();
    expect(await registry(w, false).acceptable("nwc", NWC_URL)).toBe(true);
    w.methods.push("pay_invoice");
    expect(await registry(w, false).acceptable("nwc", NWC_URL)).toBe(false);
  });

  test("sandbox server takes only sandbox devices unless JAAY_ALLOW_MIXED=1; real server never takes sandbox", async () => {
    const w = new FakeNwcWallet();
    expect(await registry(w, true).acceptable("sandbox", "")).toBe(true);
    expect(await registry(w, true).acceptable("nwc", NWC_URL)).toBe(false);
    expect(await registry(w, true, true).acceptable("nwc", NWC_URL)).toBe(true);
    expect(await registry(w, false).acceptable("sandbox", "")).toBe(false);
  });

  test("malformed connection strings are rejected without contacting the wallet", async () => {
    const w = new FakeNwcWallet();
    expect(await registry(w, false).acceptable("nwc", "nostr+walletconnect://short")).toBe(false);
    expect(await registry(w, false).acceptable("lnbits", "https://x/?api-key=nothex")).toBe(false);
    expect(w.clientsCreated).toBe(0);
  });
});

describe("NWC relay resilience (security item 10, fake transport)", () => {
  test("relay drops mid-session: calls fail fast with a typed, detail-free error, then the client reconnects", async () => {
    const w = new FakeNwcWallet();
    const b = new NwcBackend(NWC_URL, w.factory, Date.now, 200);
    const inv = await b.makeInvoice({ msat: 1000n, descriptionHashHex: DH, expirySec: 600 });
    expect(w.clientsCreated).toBe(1);

    w.mode = "down";
    // Fake timers and the clock never advanced: if the call waited for its 200 ms timeout it would never settle
    // and the test would time out. So "fails fast" is proven by logic, not by measuring wall time.
    vi.useFakeTimers();
    let err: unknown;
    try {
      err = await b.lookupInvoice(inv.paymentHash).catch((e: unknown) => e);
    } finally {
      vi.useRealTimers();
    }
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as Error).message).toBe("backend unavailable");
    expect(String((err as Error).stack)).not.toContain("walletconnect");

    w.mode = "ok";
    const inv2 = await b.makeInvoice({ msat: 2000n, descriptionHashHex: DH, expirySec: 600 });
    expect(w.clientsCreated).toBe(2); // a fresh client after the drop
    expect(await b.lookupInvoice(inv2.paymentHash)).toEqual({ state: "pending" });
    w.settleAll();
    expect(await b.lookupInvoice(inv.paymentHash)).toEqual({ state: "settled" });
  });

  test("relay hangs: the call times out within the short bound instead of hanging", async () => {
    const w = new FakeNwcWallet();
    w.mode = "hang";
    const b = new NwcBackend(NWC_URL, w.factory, Date.now, 150);
    // Fake timers: the timeout fires exactly at 150 ms of virtual time, whatever the machine load.
    vi.useFakeTimers();
    try {
      let out: unknown = "pending";
      const p = b.makeInvoice({ msat: 1000n, descriptionHashHex: DH, expirySec: 600 }).then(
        () => (out = "resolved"),
        (e: unknown) => (out = e),
      );
      await vi.advanceTimersByTimeAsync(149);
      expect(out).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(out).toBeInstanceOf(BackendUnavailable);
    } finally {
      vi.useRealTimers();
    }
    w.mode = "ok";
    await expect(b.makeInvoice({ msat: 1000n, descriptionHashHex: DH, expirySec: 600 })).resolves.toBeTruthy();
    expect(w.clientsCreated).toBe(2);
  });

  test("make_invoice passes msat, description_hash and expiry, and refuses a mainnet invoice", async () => {
    const w = new FakeNwcWallet();
    const b = new NwcBackend(NWC_URL, w.factory, Date.now, 200);
    await b.makeInvoice({ msat: 2_446_000n, descriptionHashHex: DH, expirySec: 600 });
    expect([...w.invoices.values()][0]).toMatchObject({ amount: 2_446_000, descriptionHash: DH, expiry: 600 });
    const mainnet = { ...w, factory: (u: string) => ({ ...w.factory(u), makeInvoice: async () => ({ invoice: "lnbc1pjqqqqqqqqqqqqqqqqqqqqqqqqqqqq", payment_hash: "a".repeat(64) }) }) };
    const m = new NwcBackend(NWC_URL, mainnet.factory, Date.now, 200);
    await expect(m.makeInvoice({ msat: 1000n, descriptionHashHex: DH, expirySec: 600 })).rejects.toBeInstanceOf(BackendUnavailable);
  });
});
