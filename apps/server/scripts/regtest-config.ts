import { randomBytes } from "node:crypto";
import type { Config } from "../src/config";

export const REGTEST_ENROLL_TOKEN = randomBytes(24).toString("base64url");

/** Non-sandbox server on localhost that accepts only the local S1 relay. Ephemeral key and in-memory DB. */
export function testConfigFromEnv(port: number): Config {
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    dbPath: ":memory:",
    production: false,
    sandbox: false,
    allowMixed: false,
    masterKey: new Uint8Array(randomBytes(32)),
    ephemeralMasterKey: true,
    trustProxy: false,
    lnbitsAllowedHosts: [],
    nwcAllowedRelays: ["ws://127.0.0.1:10547"],
    enrollToken: REGTEST_ENROLL_TOKEN,
    network: "regtest",
    posDir: null,
    simDir: null,
    fxFixedXofPerBtc: null,
  };
}
