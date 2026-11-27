// RoomVibe HQ service worker: installable app, offline shell, and phone notifications.
const CACHE = "rvhq-v4";
const SHELL = ["./", "index.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== "rvhq-quotes").map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return; // Firebase and fonts go straight to the network
  e.respondWith(fetch(req, { cache: "no-cache" }).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
});
self.addEventListener("push", e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (x) { p = { data: { title: "RoomVibe HQ", body: e.data ? e.data.text() : "" } }; }
  const d = p.data || p.notification || p;
  e.waitUntil(self.registration.showNotification(d.title || "RoomVibe HQ", {
    body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: d.tag || "rvhq", renotify: true, data: { url: d.url || "./#tasks" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./#tasks", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && "focus" in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
