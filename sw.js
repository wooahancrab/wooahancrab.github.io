const CACHE = "wooahan-v28";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "src/styles.css", "src/main.js", "src/config.js",
  "src/lib/api.js", "src/lib/ui.js", "src/lib/kst.js", "src/lib/report.js",
  "src/screens/manager-report.js", "src/screens/owner.js", "src/screens/attendance.js", "src/screens/attendance-admin.js", "src/lib/att-demo.js", "src/lib/geo.js", "src/screens/claims.js", "src/screens/sales.js", "src/lib/sales.js", "src/lib/bank.js", "src/lib/invoice-match.js", "src/screens/checklist.js", "src/screens/tasks.js", "src/screens/tasks-admin.js", "src/screens/checklist-admin.js", "src/screens/ceo.js", "src/lib/claims-demo.js", "src/lib/settle.js", "src/screens/settle.js", "src/screens/finance.js", "src/screens/ship.js", "src/screens/work.js", "src/lib/ship.js", "icons/icon-192.png", "icons/logo.png", "icons/logo-mark.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 같은 출처만: 네트워크 우선, 실패하면 캐시 (항상 최신 코드가 우선)
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match("index.html"))));
});

self.addEventListener("push", (e) => {
  let p = { title: "우아한게장", body: "새 알림", url: "./" };
  try { p = { ...p, ...e.data.json() }; } catch { /* 텍스트 푸시 */ }
  e.waitUntil(self.registration.showNotification(p.title, {
    body: p.body, tag: p.tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: p.url },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
