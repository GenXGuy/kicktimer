// Offline cache for KickTimer. Bump CACHE on every release so phones pick up the new files.
const CACHE = 'kicktimer-v1.6.1';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-512.png',
];
// Voice clips are cached too, but one that's missing must not block the update.
const VOICE = [
  'voice/right.wav',
  'voice/left.wav',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so an update never stores stale files.
  const requests = FILES.map((f) => new Request(f, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(requests)
      .then(() => Promise.all(VOICE.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first: works with no signal at all. Updates arrive when sw.js changes.
// Anything of ours fetched from the network (e.g. a voice clip the install missed)
// is saved too, so it works offline from then on.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
