// NetForge service worker (generated at build time from src/sw-template.js).
// Precaches the complete app so it works offline and serves it cache-first. A new version waits
// until the page asks it to take over (after the user clicks Reload). Tool input never passes
// through here: the page cannot make network requests at all (connect-src 'none').
const VERSION = '__VERSION__';
const CACHE = `netforge-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', event => {
  // Keep the previous version's cache as well: another tab may still be running it and load a
  // tool module lazily. Older NetForge caches are removed; other apps' caches are never touched.
  event.waitUntil(caches.keys().then(keys => {
    const ours = keys.filter(k => k.startsWith('netforge-'));
    const keep = new Set([CACHE, ...ours.filter(k => k !== CACHE).slice(-1)]);
    return Promise.all(ours.filter(k => !keep.has(k)).map(k => caches.delete(k)));
  }).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Routes live in the hash, so every navigation is the app shell.
    event.respondWith(caches.open(CACHE).then(cache => cache.match('./index.html', { ignoreSearch: true })).then(hit => hit || fetch(request)));
    return;
  }
  // ignoreVary: servers often send "Vary: Origin", and module scripts carry an Origin header the
  // precache requests did not, which would otherwise make every cached script miss offline.
  event.respondWith(caches.match(request, { ignoreSearch: true, ignoreVary: true }).then(hit => hit || fetch(request)));
});
