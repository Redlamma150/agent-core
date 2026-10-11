import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
// Only the app shell is cached. API responses are never cached, so no task data is stored on the device.
precacheAndRoute(self.__WB_MANIFEST);

interface PushData {
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener("push", (event) => {
  const data: PushData = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? "מערכת סוכנים", {
      body: data.body,
      icon: "/icon-192.png",
      lang: "he",
      dir: "rtl",
      data: { url: data.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string }).url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows[0];
      if (open) {
        await open.focus();
        return open.navigate(url);
      }
      return self.clients.openWindow(url);
    }),
  );
});
