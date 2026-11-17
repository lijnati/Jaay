import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Protocol source, read only. Its dist uses extensionless imports that plain Node cannot load.
    alias: { "@jaay/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)) },
  },
  test: { testTimeout: 120_000, include: ["src/**/*.test.ts"] },
});
