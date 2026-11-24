// Service worker : script que le navigateur garde installé et RÉVEILLE à la réception d'une
// notification push, même si aucun onglet de l'application n'est ouvert.
//
// Fichier statique (public/) et non module Vite : il doit être servi tel quel, à la racine
// du site (/sw.js), pour que sa portée couvre toute l'application.

// Une notification push arrive (déjà déchiffrée par le navigateur).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "WhatsApp Clone", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "WhatsApp Clone", {
      body: data.body || "Nouveau message",
      icon: "/icon-192.png",
      badge: "/badge-72.png",
      tag: data.tag, // une seule notification par conversation : la nouvelle remplace l'ancienne
      renotify: Boolean(data.tag), // … mais sonne / vibre quand même
      data: { url: data.url || "/", conversationId: data.conversationId },
    }),
  );
});

// Clic sur la notification : on rouvre (ou on ramène au premier plan) l'application,
// directement sur la bonne conversation.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = "/", conversationId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "open-conversation", conversationId });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// Nouvelle version du service worker : elle prend la main tout de suite.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
