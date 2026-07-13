// AIT MES 필요투입품목 PWA 서비스워커 (출고요청 sw.js와 분리, 스코프=필요투입_MES/)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
    await self.registration.showNotification('생산출고요청', {
      body: body || '출고요청이 있습니다.',
      icon: '../ait-logo.png',
      badge: '../ait-logo.png',
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
