// A6: serves the merchant PWA build (JAAY_POS_DIR) at /app/, same origin as the API.
// The service worker lives at /app/sw.js, so its scope is /app/ and it never sees /lnurlp, /lnurlp/cb or /r/.
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Hono } from "hono";

export const POS_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Serves a static build at `/<prefix>/` (the PWA at /app/, the customer simulator at /sim/). */
export function servePos(app: Hono, dir: string, prefix = "app"): void {
  const root = resolve(dir);
  app.get(`/${prefix}`, (c) => c.redirect(`/${prefix}/`, 301));
  app.get(`/${prefix}/*`, async (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path.slice(prefix.length + 2));
    } catch {
      return c.text("not found", 404);
    }
    if (rel.includes("\0")) return c.text("not found", 404);
    const file = resolve(root, rel === "" ? "index.html" : rel);
    if (file !== root && !file.startsWith(root + sep)) return c.text("not found", 404);

    let target = file;
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    if (!isFile) {
      // Client-side routes (no extension) get the app shell; missing assets are 404.
      if (extname(file) !== "") return c.text("not found", 404);
      target = resolve(root, "index.html");
    }
    const body = await readFile(target);
    const hashedAsset = rel.startsWith("assets/") && isFile;
    c.header("Content-Type", TYPES[extname(target)] ?? "application/octet-stream");
    c.header("Content-Security-Policy", POS_CSP);
    c.header("Cache-Control", hashedAsset ? "public, max-age=31536000, immutable" : "no-cache");
    return c.body(body);
  });
}
