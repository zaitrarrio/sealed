/*
 * Sealed service worker: Web Push only. Payloads carry nothing but a transfer id (spec §6.4.2), so the
 * notification text is generic and opening it shows the inbox, where the delivery is fetched and decrypted.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) w.postMessage({ type: "sealed-mailbox" });
      if (windows.some((w) => w.visibilityState === "visible")) return;
      await self.registration.showNotification("Sealed", {
        body: "A contact sent you files.",
        tag: "sealed-mailbox",
        renotify: true,
        data: { url: "/inbox" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/inbox";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if ("focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
