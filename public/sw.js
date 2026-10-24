// Lets phones install the app ("Add to Home screen"). The app itself always loads live,
// and nothing from the app's data or photos is ever stored here.
const CACHE = 'saf-rental-shell-v1';
const SHELL = ['icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!SHELL.some((f) => url.pathname.endsWith('/' + f))) return; // API, photos, PDFs and the page go straight to the network
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
