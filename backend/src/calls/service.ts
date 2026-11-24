// Historique des appels (table calls) et message « CALL » affiché dans la conversation.

import { prisma } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { messageSelect, toMessageDTO } from "../chat/service.js";
import { publicUserSelect } from "../routes/users.js";

export type CallType = "AUDIO" | "VIDEO";
export type FinalCallStatus = "COMPLETED" | "MISSED" | "REJECTED" | "BUSY";

export const callSelect = {
  id: true,
  conversationId: true,
  callerId: true,
  calleeId: true,
  type: true,
  status: true,
  startedAt: true,
  answeredAt: true,
  endedAt: true,
} as const;

// L'autre personne d'une conversation PRIVÉE dont je suis membre.
export async function calleeOf(callerId: string, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true, participants: { select: { userId: true } } },
  });
  if (!conversation || !conversation.participants.some((p) => p.userId === callerId)) {
    throw notFound("Conversation introuvable");
  }
  if (conversation.type !== "PRIVATE") throw badRequest("Appels de groupe non pris en charge");
  const other = conversation.participants.find((p) => p.userId !== callerId);
  if (!other) throw notFound("Conversation introuvable");
  return other.userId;
}

export const callerProfile = (userId: string) =>
  prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect });

export const createCall = (data: { conversationId: string; callerId: string; calleeId: string; type: CallType }) =>
  prisma.call.create({ data, select: callSelect });

export const markAnswered = (callId: string) =>
  prisma.call.update({ where: { id: callId }, data: { status: "ONGOING", answeredAt: new Date() }, select: callSelect });

// Fin d'un appel : statut final + message « CALL » dans la conversation, en une transaction.
// Le message est daté du DÉBUT de l'appel : il apparaît là où l'appel a commencé.
export async function finishCall(callId: string, status: FinalCallStatus) {
  return prisma.$transaction(async (tx) => {
    const call = await tx.call.update({ where: { id: callId }, data: { status, endedAt: new Date() }, select: callSelect });
    const message = await tx.message.create({
      data: {
        conversationId: call.conversationId,
        senderId: call.callerId,
        type: "CALL",
        callId: call.id,
        createdAt: call.startedAt,
      },
      select: messageSelect,
    });
    await tx.conversation.update({ where: { id: call.conversationId }, data: { updatedAt: new Date() } });
    return { call, message: toMessageDTO(message) };
  });
}

// Au démarrage : des appels peuvent être restés « en cours » si le serveur s'est arrêté brutalement
// (l'état des appels vit en mémoire). On les clôt proprement.
export async function closeStaleCalls() {
  const stale = await prisma.call.findMany({
    where: { status: { in: ["RINGING", "ONGOING"] } },
    select: { id: true, status: true },
  });
  for (const call of stale) await finishCall(call.id, call.status === "ONGOING" ? "COMPLETED" : "MISSED");
  return stale.length;
}
