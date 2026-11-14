import { deriveConfirmCode, deriveKeys, generateDeviceSecret, type DeviceKeys } from "@jaay/protocol";
import { beforeEach, expect, test } from "vitest";
import { MAX_ATTEMPTS, tryConfirm } from "./confirm";
import { getSale, putSale, resetConnection, type SaleRec } from "./db";

let keys: DeviceKeys;
const sid = "AAAAAAAAAAA";
const rec = (over: Partial<SaleRec> = {}): SaleRec => ({ sid, amountXof: 1000, createdAt: 1, windowEndsAt: 2, status: "open", attempts: 0, qr: "LIGHTNING:X", ...over });
const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

beforeEach(async () => {
  keys = await deriveKeys(generateDeviceSecret());
});

test("the correct code confirms the sale and records the time", async () => {
  await putSale(rec());
  expect(await tryConfirm(sid, await deriveConfirmCode(keys, sid), keys, 5000)).toBe("confirmed");
  expect(await getSale(sid)).toMatchObject({ status: "confirmed", attempts: 1, confirmedAt: 5000 });
});

test("a wrong code is refused without saying how close it was; three wrong codes lock the sale", async () => {
  await putSale(rec());
  const wrong = wrongOf(await deriveConfirmCode(keys, sid));
  expect(MAX_ATTEMPTS).toBe(3);
  expect(await tryConfirm(sid, wrong, keys, 1)).toBe("wrong");
  expect(await tryConfirm(sid, "12345", keys, 1)).toBe("wrong"); // malformed input still costs an attempt
  expect(await tryConfirm(sid, wrong, keys, 1)).toBe("locked");
  expect(await getSale(sid)).toMatchObject({ status: "locked", attempts: 3 });
  // Locked is final for confirmation: even the right code is refused and does not count.
  expect(await tryConfirm(sid, await deriveConfirmCode(keys, sid), keys, 1)).toBe("refused");
  expect((await getSale(sid))!.attempts).toBe(3);
});

test("the attempt is persisted BEFORE it is evaluated: a crash right after the write still counts", async () => {
  await putSale(rec({ attempts: 2 }));
  const crash = () => {
    throw new Error("app killed");
  };
  await expect(tryConfirm(sid, "000000", keys, 1, { afterAttemptPersisted: crash })).rejects.toThrow("app killed");
  resetConnection(); // the app restarts
  expect((await getSale(sid))!.attempts).toBe(3);
  // After the crash, even the correct code cannot confirm: the cap is already spent.
  expect(await tryConfirm(sid, await deriveConfirmCode(keys, sid), keys, 1)).toBe("locked");
  expect((await getSale(sid))!.status).toBe("locked");
});

test("attempts survive a reload", async () => {
  await putSale(rec());
  const wrong = wrongOf(await deriveConfirmCode(keys, sid));
  await tryConfirm(sid, wrong, keys, 1);
  resetConnection();
  expect((await getSale(sid))!.attempts).toBe(1);
  await tryConfirm(sid, wrong, keys, 1);
  resetConnection();
  expect(await tryConfirm(sid, wrong, keys, 1)).toBe("locked");
});

test("concurrent attempts cannot exceed the cap", async () => {
  await putSale(rec());
  const wrong = wrongOf(await deriveConfirmCode(keys, sid));
  const results = await Promise.all(Array.from({ length: 6 }, () => tryConfirm(sid, wrong, keys, 1)));
  expect(results.filter((r) => r === "wrong")).toHaveLength(2);
  expect(results.filter((r) => r === "locked")).toHaveLength(1); // the third locks the sale
  expect(results.filter((r) => r === "refused")).toHaveLength(3); // a locked sale refuses further attempts
  expect((await getSale(sid))!.attempts).toBe(3);
});

test.each(["cancelled", "confirmed", "paid", "mismatch", "unpaid"] as const)("a %s sale is refused and attempts do not change", async (status) => {
  await putSale(rec({ status }));
  expect(await tryConfirm(sid, await deriveConfirmCode(keys, sid), keys, 1)).toBe("refused");
  expect((await getSale(sid))!.attempts).toBe(0);
});

test("an expired (local window) sale can still be confirmed with the right code", async () => {
  await putSale(rec({ status: "expired" }));
  expect(await tryConfirm(sid, await deriveConfirmCode(keys, sid), keys, 1)).toBe("confirmed");
});

test("unknown sale is refused", async () => {
  expect(await tryConfirm("BBBBBBBBBBB", "123456", keys, 1)).toBe("refused");
});
