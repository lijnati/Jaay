import { expect, test } from "vitest";
import { name } from "./index";

test("exports its package name", () => {
  expect(name).toBe("@jaay/customer-sim");
});
