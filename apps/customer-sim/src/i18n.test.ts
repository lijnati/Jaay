import { expect, test } from "vitest";
import { CATALOG } from "./i18n";

test("every English key exists in French, non-empty, same placeholders; banner says SANDBOX and simulator", () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
  expect(Object.keys(CATALOG.fr).sort()).toEqual(Object.keys(CATALOG.en).sort());
  for (const k of Object.keys(CATALOG.en) as (keyof typeof CATALOG.en)[]) {
    expect(CATALOG.fr[k].trim(), k).not.toBe("");
    expect(ph(CATALOG.fr[k]), k).toBe(ph(CATALOG.en[k]));
  }
  expect(CATALOG.en.banner).toBe("SANDBOX customer wallet (simulator, not a real wallet)");
  expect(CATALOG.fr.banner).toMatch(/^SANDBOX .*simulateur/);
});
