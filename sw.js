// オフライン用の Service Worker: ビューアのファイル（このサイト自身の4ファイル）だけを保存する。
// 動画は保存しない（利用者が選んだ動画は端末の中で読むだけ）。
const CACHE = 'tilt360-public-v1';
const FILES = ['./', 'index.html', 'app.js', 'style.css'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// 新しい版を取りに行き（保存も更新）、届かなければ保存版を使う
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await Promise.race([fetch(req), new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 3000))]);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (err) {
      return (await c.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});
