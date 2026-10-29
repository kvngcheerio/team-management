// Service worker: keeps the app shell (HTML, JS, CSS, fonts, icons) on the phone so the app opens
// without signal. API responses are never cached here; the app keeps its own copy of the last data.
const CACHE = "matchday-shell";

self.addEventListener("install", (event) => {
  event.waitUntil(refreshShell().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Pages: network first, so a deploy shows up straight away; the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) event.waitUntil(refreshShell(res.clone()).catch(() => {}));
          return res;
        })
        .catch(() => caches.match("/").then((cached) => cached || Response.error())),
    );
    return;
  }

  // Hashed build files never change; icons and the manifest rarely do.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname === "/favicon.svg") {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
            }
            return res;
          }),
      ),
    );
  }
});

/**
 * Cache the current index.html and every build file it needs (scripts, styles and the fonts the styles
 * load), then drop build files from older deploys.
 */
async function refreshShell(indexResponse) {
  const cache = await caches.open(CACHE);
  const res = indexResponse || (await fetch("/", { cache: "no-cache" }));
  if (!res.ok) return;
  const html = await res.clone().text();
  const wanted = new Set(["/favicon.svg", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"]);
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) wanted.add(m[1]);
  for (const path of [...wanted].filter((p) => p.endsWith(".css"))) {
    const css = await (await fetch(path)).text();
    for (const m of css.matchAll(/url\(["']?(\/assets\/[^"')]+)["']?\)/g)) wanted.add(m[1]);
  }
  await cache.put("/", res);
  const have = await cache.keys();
  const missing = [...wanted].filter((p) => !have.some((r) => new URL(r.url).pathname === p));
  await Promise.all(missing.map((p) => cache.add(p).catch(() => {})));
  for (const r of have) {
    const path = new URL(r.url).pathname;
    if (path.startsWith("/assets/") && !wanted.has(path)) await cache.delete(r);
  }
}
