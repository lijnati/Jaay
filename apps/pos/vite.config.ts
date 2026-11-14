// Merchant PWA build. Served by the server at /app/ (JAAY_POS_DIR). BUILD_ID marks the build (update flow).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const build = process.env.BUILD_ID ?? "dev";

export default defineConfig({
  base: "/app/",
  resolve: { alias: { "@jaay/protocol": here("../../packages/protocol/src/index.ts") } },
  define: { __BUILD__: JSON.stringify(build) },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0, modulePreload: false },
  plugins: [
    {
      // Hand-written service worker (spike S3): precache list and content hash injected at build time.
      name: "jaay-sw",
      apply: "build",
      enforce: "post",
      generateBundle(_, bundle) {
        const h = createHash("sha256").update(build);
        for (const [name, out] of Object.entries(bundle)) h.update(name).update(out.type === "chunk" ? out.code : out.source);
        const publicFiles = readdirSync(here("./public"));
        const files = ["/app/", ...Object.keys(bundle).map((f) => `/app/${f}`), ...publicFiles.map((f) => `/app/${f}`)];
        const source = readFileSync(here("./sw-template.js"), "utf8")
          .replace("__VERSION__", h.digest("hex").slice(0, 12))
          .replace("__PRECACHE__", JSON.stringify(files));
        this.emitFile({ type: "asset", fileName: "sw.js", source });
      },
    },
  ],
});
