const CACHE = "private-reserve-v35";
const ASSETS = ["./", "./index.html", "./manifest.json", "./admin.html", "./admin-manifest.json", "./icon-192.png", "./icon-512.png", "./fonts/Boucherie_Block.ttf", "./fonts/Boucherie_Block.otf", "./logo.png"];
const PAGE_PATHS = ["/", "/index.html", "/admin.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(ASSETS.map((asset) => c.add(asset)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isPage = e.request.mode === "navigate" || PAGE_PATHS.includes(url.pathname);

  if (isPage) {
    // Network-first for the app pages themselves, so a fresh deploy is picked up
    // immediately whenever there's a connection. Cache is only a fallback for
    // when the device is offline.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).catch(() => caches.match("./index.html")))
  );
});
