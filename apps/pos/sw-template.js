// jaay service worker. Scope /app/. Cache-first for the app shell only.
// A page under its control sends ALL its fetches here, so everything outside /app/ (the device API, /lnurlp,
// /r/) is left to the network untouched. A new version installs in the background and waits until the
// merchant taps Update (never in the middle of a sale).
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/app/")) return;
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") return (await c.match("/app/")) ?? fetch(req);
      return fetch(req);
    }),
  );
});
