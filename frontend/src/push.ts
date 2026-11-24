// Notifications push côté navigateur : service worker, permission, abonnement.

import { apiFetch } from "./api";

export type PushState = "unsupported" | "denied" | "off" | "on";

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;

let registration: Promise<ServiceWorkerRegistration> | null = null;

// Installe le service worker (une fois). Nécessaire aussi pour les notifications LOCALES.
export function registerServiceWorker() {
  if (!supported()) return null;
  registration ??= navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
  return registration;
}

// La clé VAPID est en base64url ; le navigateur la veut en octets.
function base64UrlToBytes(value: string) {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const send = (subscription: PushSubscription) =>
  apiFetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

// Au démarrage : si ce navigateur est déjà abonné, l'abonnement est rattaché à l'utilisateur
// ACTUELLEMENT connecté (navigateur partagé : on ne reçoit pas les messages du compte précédent).
export async function syncPushSubscription() {
  if ((await pushState()) !== "on") return;
  const sub = await (await registerServiceWorker())!.pushManager.getSubscription();
  if (sub) await send(sub);
}

// Bouton « Activer les notifications » : permission, abonnement auprès du service push
// du navigateur, puis envoi de l'abonnement au backend.
export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission(); // doit suivre un clic
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const reg = (await registerServiceWorker())!;
  const { publicKey } = await apiFetch<{ publicKey: string }>("/api/push/vapid-public-key");
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true, // promesse faite au navigateur : chaque push affiche une notification
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  await send(subscription);
  return "on";
}

// Désactivation (ou déconnexion) : désabonnement côté serveur ET côté navigateur.
export async function disablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const sub = await (await registerServiceWorker())!.pushManager.getSubscription();
  if (sub) {
    await apiFetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {}); // token expiré… : le serveur nettoiera au prochain envoi (410)
    await sub.unsubscribe();
  }
  return Notification.permission === "denied" ? "denied" : "off";
}

// Onglet ouvert mais en arrière-plan : notification LOCALE (pas de push, le message est déjà là).
export async function showLocalNotification(n: { title: string; body: string; tag: string; conversationId: string }) {
  if (!supported() || Notification.permission !== "granted") return;
  const reg = await registerServiceWorker();
  await reg?.showNotification(n.title, {
    body: n.body,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    tag: n.tag,
    renotify: true,
    data: { url: `/?c=${n.conversationId}`, conversationId: n.conversationId },
  } as NotificationOptions);
}
