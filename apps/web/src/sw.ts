/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const payload = event.data.json() as { title?: string; body?: string; job_id?: string };
  event.waitUntil(
    self.registration.showNotification(payload.title ?? "AgentHub", {
      body: payload.body ?? "Job update",
      data: { jobId: payload.job_id },
      icon: "/favicon.svg"
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const jobId = (event.notification.data?.jobId as string | undefined) ?? "";
  const target = `/jobs${jobId ? `?job=${jobId}` : ""}`;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

export {};
