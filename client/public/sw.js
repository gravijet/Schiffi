/**
 * Service worker.
 *
 * Two jobs, and deliberately no more:
 *
 *   1. Serve the built shell instantly on a repeat visit. Everything under
 *      /assets/ carries a content hash in its name, so it can be cached
 *      forever and never goes stale.
 *   2. Keep the terrain blob. It is by far the largest download and it never
 *      changes for a given world, so caching it turns the second load of a
 *      world from a few hundred kilobytes into nothing.
 *
 * What it must NOT do is cache the API. Coins, cargo, prices and positions are
 * live state owned by the server; a cached answer there would be a lie, and
 * this game's whole design says the server is the only source of truth.
 */
const VERSION = 'schiffi-v1';
const SHELL = `${VERSION}-shell`;
const TERRAIN = `${VERSION}-terrain`;
const KEEP = new Set([SHELL, TERRAIN]);

/** How many worlds' terrain to keep before evicting the oldest. */
const TERRAIN_LIMIT = 4;

self.addEventListener('install', (event) => {
  // The shell is filled in as it is requested rather than precached: the asset
  // names carry hashes this file cannot know without a build step reading them.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (!KEEP.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live state is never cached, in either direction.
  if (url.pathname.startsWith('/api/') && !isTerrain(url)) return;
  if (url.pathname.startsWith('/ws')) return;

  if (isTerrain(url)) {
    event.respondWith(cacheFirst(request, TERRAIN, { limit: TERRAIN_LIMIT }));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  // The document itself: network first, so a new build is picked up at once,
  // with the cached copy as the answer when the network is not there.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(request, SHELL));
  }
});

const isTerrain = (url) => /^\/api\/worlds\/[^/]+\/terrain$/.test(url.pathname);

async function cacheFirst(request, cacheName, { limit = 0 } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (limit) await trim(cache, limit);
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

/** Keep a cache to `limit` entries, dropping the oldest first. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}
