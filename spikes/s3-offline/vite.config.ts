// Spike S3. QR_LIB picks the QR module (gen = qrcode-generator, node = qrcode); BUILD_ID marks the build.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const lib = process.env.QR_LIB ?? "gen";
const build = process.env.BUILD_ID ?? "v1";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Real protocol source, read-only, compiled by Vite. packages/protocol is not modified.
      "@jaay/protocol": here("../../packages/protocol/src/index.ts"),
      "qr-impl": here(`./src/qr-${lib}.ts`),
    },
  },
  define: { __BUILD__: JSON.stringify(build) },
  build: { outDir: `dist-${lib}-${build}`, emptyOutDir: true, target: "es2022" },
  plugins: [
    {
      // Hand-written service worker: the precache list and a content hash are injected at build time.
      name: "s3-sw",
      apply: "build",
      enforce: "post",
      generateBundle(_, bundle) {
        const h = createHash("sha256").update(build);
        for (const [name, out] of Object.entries(bundle)) {
          h.update(name).update(out.type === "chunk" ? out.code : out.source);
        }
        const files = ["/", ...Object.keys(bundle).map((f) => `/${f}`), "/manifest.webmanifest", "/icon.svg"];
        const source = readFileSync(here("./sw-template.js"), "utf8")
          .replace("__VERSION__", h.digest("hex").slice(0, 12))
          .replace("__PRECACHE__", JSON.stringify(files));
        this.emitFile({ type: "asset", fileName: "sw.js", source });
      },
    },
  ],
});
