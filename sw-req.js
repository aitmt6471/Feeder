// AIT MES 필요투입품목 PWA 서비스워커 (홈화면 설치용, 앱셸 캐시 + 푸시)
const CACHE = 'feeder-v1';
const SHELL = ['./', 'index.html', 'js/api.js', 'js/mes-auth.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'ait-logo.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 앱셸: 동일 출처 GET만 처리(네트워크 우선, 실패 시 캐시). n8n(교차출처) 요청은 건드리지 않음.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(CACHE); c.put(req, net.clone()); }
      return net;
    } catch (_) {
      const cached = await caches.match(req);
      return cached || caches.match('index.html');
    }
  })());
});

// 푸시 수신 → 최신 알림 문구 조회 후 '○○ 새 필요투입품목…' 알림
const REQ_LATEST_URL = 'https://aitechn8n.ngrok.app/webhook/ait/mes/req-push-latest';
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let body = '';
    // payload에 body가 실려오면 우선 사용
    try { if (e.data) { const d = e.data.json(); if (d && d.body) body = d.body; } } catch (_) {}
    // payload 없으면 서버에서 최신 알림 문구 조회
    if (!body) {
      try {
        const r = await fetch(REQ_LATEST_URL, { cache: 'no-store' });
        if (r.ok) { const j = await r.json(); body = (j && j.body) || ''; }
      } catch (_) {}
    }
    await self.registration.showNotification('필요투입품목', {
      body: body || '출고요청이 있습니다.',
      icon: 'ait-logo.png',
      badge: 'ait-logo.png',
      vibrate: [120, 60, 120],
      data: { url: 'index.html' }
    });
  })());
});

// 알림 클릭 → 필요투입 화면 열기/포커스
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url.includes('필요투입_MES') && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('index.html');
  })());
});
