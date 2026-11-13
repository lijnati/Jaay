// Production bundle: one ESM file runnable with plain `node dist/server.mjs`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/server.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  alias: { "@jaay/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)) },
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log("built dist/server.mjs");
