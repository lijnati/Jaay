import { expect, test } from "vitest";
import { name } from "./index";
import { pickLang } from "./receipt";
import { RateLimiter } from "./ratelimit";

test("exports its package name", () => {
  expect(name).toBe("@jaay/server");
});

test("rate limiter: fixed window per key, bounded memory", () => {
  let t = 0;
  const rl = new RateLimiter(2, 1000, () => t, 10);
  expect([rl.allow("a"), rl.allow("a"), rl.allow("a")]).toEqual([true, true, false]);
  expect(rl.allow("b")).toBe(true);
  t = 1000;
  expect(rl.allow("a")).toBe(true);
  for (let i = 0; i < 100; i++) rl.allow(`k${i}`);
  expect((rl as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(10);
});

test("receipt language: French unless the first preference is English", () => {
  expect(pickLang(undefined)).toBe("fr");
  expect(pickLang("fr-SN,fr;q=0.9,en;q=0.8")).toBe("fr");
  expect(pickLang("wo-SN,fr;q=0.8")).toBe("fr");
  expect(pickLang("en-US,en;q=0.9")).toBe("en");
});
