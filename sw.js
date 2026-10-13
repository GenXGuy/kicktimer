// Offline cache for KickTimer. Bump CACHE on every release so phones pick up the new files.
const CACHE = 'kicktimer-v1.5.0';
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
  'voice/david-right-100.wav',
  'voice/david-right-125.wav',
  'voice/david-right-150.wav',
  'voice/david-right-175.wav',
  'voice/david-left-100.wav',
  'voice/david-left-125.wav',
  'voice/david-left-150.wav',
  'voice/david-left-175.wav',
  'voice/zira-right-100.wav',
  'voice/zira-right-125.wav',
  'voice/zira-right-150.wav',
  'voice/zira-right-175.wav',
  'voice/zira-left-100.wav',
  'voice/zira-left-125.wav',
  'voice/zira-left-150.wav',
  'voice/zira-left-175.wav',
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
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
