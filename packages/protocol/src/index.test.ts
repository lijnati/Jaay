import { expect, test } from "vitest";
import * as api from "./index";

test("exports the M1 public API and no internal helpers", () => {
  const fns = Object.keys(api)
    .filter((k) => typeof (api as Record<string, unknown>)[k] === "function")
    .sort();
  expect(fns).toEqual(
    [
      "DecodeError",
      "buildSaleLnurl",
      "constantTimeEqual",
      "decodeSale",
      "deriveConfirmCode",
      "deriveKeys",
      "encodeSale",
      "generateDeviceSecret",
      "lnurlDecode",
      "lnurlEncode",
      "newDeviceId",
      "peekDeviceId",
      "secretFromString",
      "secretToString",
      "toQrString",
      "verifyConfirmCode",
    ].sort(),
  );
  expect(api.PROTOCOL_VERSION).toBe(1);
  expect(api.TOKEN_CHARS).toBe(78);
  expect(api.MIN_AMOUNT_XOF).toBe(50);
  expect(api.MAX_AMOUNT_XOF).toBe(5_000_000);
  expect(api.MAX_TOKEN_CHARS).toBe(256);
});

test("full flow through the public API", async () => {
  const secret = api.generateDeviceSecret();
  const keys = await api.deriveKeys(
    api.secretFromString(api.secretToString(secret)),
  );
  const deviceId = api.newDeviceId();
  const { token, sid } = await api.encodeSale(keys, deviceId, {
    amountXof: 2500,
  });
  expect(api.peekDeviceId(token)).toBe(deviceId);
  const lnurl = api.buildSaleLnurl("https://pay.example.sn", token);
  expect(
    api.lnurlDecode(api.toQrString(lnurl).slice("LIGHTNING:".length)),
  ).toBe(`https://pay.example.sn/lnurlp?p=${token}`);
  const sale = await api.decodeSale(token, keys);
  expect(sale).toEqual({ deviceId, amountXof: 2500, sid });
  const code = await api.deriveConfirmCode(keys, sale.sid);
  expect(await api.verifyConfirmCode(keys, sid, code)).toBe(true);
});
