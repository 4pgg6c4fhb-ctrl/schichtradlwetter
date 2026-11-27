// App-Hülle offline verfügbar machen; Wetterdaten immer frisch aus dem Netz.
const CACHE = 'wetter-v22';
const SHELL = ['./', 'index.html', 'core.js', 'app.js', 'core.js?v=22', 'app.js?v=22', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // immer beim Server nachfragen (GitHub Pages lässt Browser sonst bis zu 10 min alte Dateien nutzen)
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
