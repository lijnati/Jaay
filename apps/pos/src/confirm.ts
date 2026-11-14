// Confirm-code check (Hard rule 3). The code is recomputed from the sale id with the stored HMAC key and compared
// in constant time (best effort in JS) by the protocol. At most 3 attempts per sale; each attempt is written to
// IndexedDB BEFORE it is evaluated, so a reload or crash can never hand back a free attempt.
import { verifyConfirmCode, type DeviceKeys } from "@jaay/protocol";
import { getSale, putSale } from "./db";
import { confirmable, transition } from "./ledger";

export const MAX_ATTEMPTS = 3;
export type ConfirmResult = "confirmed" | "wrong" | "locked" | "refused";

// Attempts are serialized in this tab, so concurrent taps cannot both read the same counter.
let chain: Promise<unknown> = Promise.resolve();

export function tryConfirm(
  sid: string,
  entered: string,
  keys: DeviceKeys,
  now: number,
  hooks: { afterAttemptPersisted?: () => void } = {},
): Promise<ConfirmResult> {
  const run = chain.then(async (): Promise<ConfirmResult> => {
    const rec = await getSale(sid);
    if (!rec || !confirmable(rec.status)) return "refused";
    if (rec.attempts >= MAX_ATTEMPTS) {
      // The cap was spent (for example the app died after the third write): lock, do not evaluate.
      await putSale({ ...rec, status: transition(rec.status, "lock")! });
      return "locked";
    }
    const attempts = rec.attempts + 1;
    await putSale({ ...rec, attempts }); // committed before the check
    hooks.afterAttemptPersisted?.();

    const ok = /^\d{6}$/.test(entered) && (await verifyConfirmCode(keys, sid, entered));
    if (ok) {
      await putSale({ ...rec, attempts, status: transition(rec.status, "confirm")!, confirmedAt: now });
      return "confirmed";
    }
    if (attempts >= MAX_ATTEMPTS) {
      await putSale({ ...rec, attempts, status: transition(rec.status, "lock")! });
      return "locked";
    }
    return "wrong";
  });
  chain = run.catch(() => {});
  return run;
}
