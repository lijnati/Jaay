// SANDBOX customer wallet simulator. Served by the server at /sim/ (JAAY_SIM_DIR).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/sim/",
  resolve: { alias: { "@jaay/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0, modulePreload: false },
});
