/* Airgap Desk service worker.
 * Strategy: cache-first for same-origin assets, network-first for navigations
 * with a cached fallback. The page tells us which resources it used after load,
 * so a second visit works with no network at all.
 */
const CACHE = 'airgap-v1';
const CORE = ['/', '/capture/', '/verify/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then(async (cache) => {
        await Promise.all(
          data.urls.map(async (url) => {
            try {
              const existing = await cache.match(url);
              if (existing) return;
              const res = await fetch(url, { cache: 'reload' });
              if (res.ok) await cache.put(url, res.clone());
            } catch {
              /* offline or blocked: ignore */
            }
          }),
        );
      }),
    );
  }
});

async function fetchWithTimeout(req, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(req, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetchWithTimeout(req, 4000);
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const hit = (await cache.match(req)) || (await cache.match('/capture/')) || (await cache.match('/'));
          if (hit) return hit;
          return new Response('Offline and this page was never cached.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetchWithTimeout(req, 5000);
        if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return new Response('', { status: 504 });
      }
    })(),
  );
});
