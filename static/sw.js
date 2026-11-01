// Service worker (served at SITE_PATH/sw.js so it covers the whole app). It makes the app
// installable and lets it open without a connection, showing your tasks as last loaded
// (changes made offline wait in app.js's outbox).
// Everything goes to the network first, so a deploy takes effect on the next load; only
// the app page, Help, its static files and /api/data are kept, for when the network fails.
// Signing in again (login.html) empties the cache.

const CACHE = "entropicide-v1";

self.addEventListener("install", () => self.skipWaiting());
// (Also drops the cache from before the rename, "todo-v1".)
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
])));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope).pathname;
  if (req.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(scope)) return;
  const path = url.pathname.slice(scope.length);
  const keep = req.mode === "navigate" ? path === "" || path === "help"
    : path.startsWith("static/") || path === "api/data";
  if (!keep) return;
  const key = url.origin + url.pathname;  // /api/data?now=… is one entry
  const saved = async () => (await caches.match(key)) || Response.error();
  e.respondWith(fetch(req).then((res) => {
    // A redirect means signed out (to the login page): don't keep that as the app.
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    // 502-504: Apache is up but the app isn't, which is as good as offline.
    return res.status >= 502 ? caches.match(key).then((hit) => hit || res) : res;
  }).catch(saved));
});

// ---- notifications (reminders; sent by app.py's send_reminders) ----

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: e.data?.text() }; }
  const scope = self.registration.scope;
  e.waitUntil(self.registration.showNotification(m.title || "Entropicide", {
    body: m.body || "",
    tag: m.tag,
    renotify: !!m.tag,
    icon: scope + "static/icons/icon-192.png",
    badge: scope + "static/icons/badge-96.png",
    data: { task: m.task || null },
    // A task's reminder: Done, and snoozes (as many as the device shows; Android shows 2).
    actions: m.snooze ? [{ action: "done", title: "✓ Done" }, { action: "1h", title: "Snooze 1 hour" },
      { action: "tomorrow", title: "Tomorrow" }].slice(0, Notification.maxActions || 2) : [],
  }));
});

self.addEventListener("notificationclick", (e) => {
  const scope = self.registration.scope;
  const { task } = e.notification.data || {};
  e.notification.close();
  if (e.action && task) {
    // Done: completed (a repeating task's next copy is made as usual). Snooze: the server
    // reminds again then. Open pages catch up; if it didn't work, say so.
    const done = e.action === "done";
    e.waitUntil(fetch(`${scope}api/tasks/${task}` + (done ? "" : "/snooze"), {
      method: done ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "entropicide" },
      body: JSON.stringify(done ? { completed: true } : { until: e.action }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(res.status);
      for (const win of await self.clients.matchAll({ type: "window" })) win.postMessage({ refresh: true });
    }).catch(() => self.registration.showNotification(e.notification.title, {
      body: `Couldn't ${done ? "mark it done" : "snooze it"} (no connection, or signed out). Tap to open Entropicide.`,
      tag: e.notification.tag, icon: e.notification.icon, badge: e.notification.badge,
      data: e.notification.data,
    })));
    return;
  }
  // Open the app (or bring it forward) at the task.
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(scope));
    if (win) {
      if (task) win.postMessage({ openTask: task });
      return win.focus();
    }
    return self.clients.openWindow(task ? `${scope}?task=${task}` : scope);
  }));
});
