// Notifications push (Web Push).
//
// Parcours :
//   1. le navigateur s'abonne auprès de SON service push (Google pour Chrome/Edge, Mozilla pour
//      Firefox…) et nous envoie l'abonnement : une adresse (endpoint) + ses clés publiques ;
//   2. quand un message arrive pour un utilisateur HORS LIGNE (aucun onglet ouvert), le backend
//      CHIFFRE la notification avec les clés du navigateur (RFC 8291), la SIGNE avec sa clé VAPID
//      (RFC 8292) et la poste à l'endpoint ;
//   3. le service push la remet au navigateur, qui réveille notre service worker (sw.js),
//      même si aucun onglet n'est ouvert.
// Le service push ne peut PAS lire la notification : il ne transporte que des octets chiffrés.

import webpush from "web-push";
import { config } from "../config.js";
import { prisma } from "../db.js";

export interface PushPayload {
  title: string;
  body: string;
  tag: string; // une notification par conversation : la suivante remplace la précédente
  url: string; // ouverte au clic
  conversationId: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Envoi effectif. Remplaçable dans les tests (aucun appel réseau vers Google / Mozilla).
export type PushSender = (target: PushTarget, payload: string) => Promise<{ statusCode: number }>;

// Options d'envoi : signature VAPID, durée de conservation, priorité.
export function pushRequestOptions(): webpush.RequestOptions {
  const { publicKey, privateKey, subject } = config.push;
  return {
    vapidDetails: { subject, publicKey, privateKey },
    TTL: 24 * 60 * 60, // si le téléphone est éteint, le service push garde la notification 24 h
    urgency: "high",
  };
}

export const webPushSender: PushSender = (target, payload) =>
  webpush.sendNotification(target, payload, pushRequestOptions());

// ---------- Abonnements ----------

export async function saveSubscription(userId: string, sub: PushTarget) {
  // upsert par endpoint : un même navigateur peut changer de compte (déconnexion / connexion).
  // L'abonnement suit alors le NOUVEL utilisateur, l'ancien ne reçoit plus rien ici.
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
}

// Seul le propriétaire peut supprimer son abonnement.
export async function deleteSubscription(userId: string, endpoint: string) {
  const { count } = await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return count > 0;
}

// ---------- Contenu ----------

const MEDIA_LABEL: Record<string, string> = {
  IMAGE: "📷 Photo",
  VIDEO: "🎥 Vidéo",
  AUDIO: "🎤 Message vocal",
  DOCUMENT: "📄 Document",
};

const truncate = (text: string, max = 180) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface MessageForPush {
  conversationId: string;
  senderName: string;
  type: string;
  content: string | null;
  media: { fileName: string | null } | null;
}

// « Alice » / « Tu es dispo samedi ? » en privé ; « Week-end » / « Alice : … » en groupe.
export function buildPayload(message: MessageForPush, groupName: string | null): PushPayload {
  const media =
    message.type === "DOCUMENT" && message.media?.fileName ? `📄 ${message.media.fileName}` : MEDIA_LABEL[message.type];
  const text = [media, message.content].filter(Boolean).join(" · ") || "Nouveau message";
  return {
    title: groupName ?? message.senderName,
    body: truncate(groupName ? `${message.senderName} : ${text}` : text),
    tag: `conversation-${message.conversationId}`,
    url: `/?c=${message.conversationId}`,
    conversationId: message.conversationId,
  };
}

// ---------- Envoi ----------

// Nouveau message : notifie les destinataires donnés (ceux qui n'ont aucun onglet ouvert).
export async function notifyNewMessage(
  message: MessageForPush,
  conversationType: "PRIVATE" | "GROUP",
  userIds: string[],
  send: PushSender = webPushSender,
) {
  if (!config.push.enabled || userIds.length === 0) return 0;
  const groupName =
    conversationType === "GROUP"
      ? ((await prisma.conversation.findUnique({ where: { id: message.conversationId }, select: { name: true } }))
          ?.name ?? "Groupe")
      : null;
  return sendPush(userIds, buildPayload(message, groupName), send);
}

// Envoie la notification à tous les navigateurs abonnés des utilisateurs donnés.
// Un abonnement expiré (404 / 410 : désinstallé, permission retirée…) est supprimé.
export async function sendPush(userIds: string[], payload: PushPayload, send: PushSender = webPushSender) {
  if (!config.push.enabled || userIds.length === 0) return 0;
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } });
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.deleteMany({ where: { id: s.id } });
        } else {
          console.error(`Notification push non envoyée (${status ?? "réseau"}) :`, (err as Error).message);
        }
      }
    }),
  );
  return sent;
}
