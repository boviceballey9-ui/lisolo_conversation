// Logique métier du chat, partagée par les routes HTTP et le serveur Socket.io.
// Ne dépend ni d'Express ni de Socket.io : facile à tester et à réutiliser.

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { publicUserSelect } from "../routes/users.js";

export type DeliveryStatus = "SENT" | "DELIVERED" | "READ";

const STATUS_RANK: Record<DeliveryStatus, number> = { SENT: 0, DELIVERED: 1, READ: 2 };

// Champs lus pour chaque message.
const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  type: true,
  content: true,
  createdAt: true,
  statuses: { select: { userId: true, status: true } },
} as const;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

// Forme envoyée au client. `status` = le statut le moins avancé parmi les destinataires
// (en 1-à-1 : celui de l'unique destinataire). C'est ce qui donne ✓ / ✓✓ / ✓✓ bleu.
export function toMessageDTO(m: MessageRow) {
  const status = m.statuses.reduce<DeliveryStatus>(
    (min, s) => (STATUS_RANK[s.status] < STATUS_RANK[min] ? s.status : min),
    "READ",
  );
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    type: m.type,
    content: m.content,
    createdAt: m.createdAt,
    status: m.statuses.length ? status : ("SENT" as DeliveryStatus),
  };
}
export type MessageDTO = ReturnType<typeof toMessageDTO>;

// ---------- Conversations ----------

export const directKeyFor = (a: string, b: string) => [a, b].sort().join(":");

export async function assertParticipant(userId: string, conversationId: string) {
  const participant = await prisma.participant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { userId: true },
  });
  // 404 plutôt que 403 : on ne révèle pas qu'une conversation existe.
  if (!participant) throw notFound("Conversation introuvable");
}

async function findOrCreatePrivateConversation(meId: string, otherId: string): Promise<string> {
  const directKey = directKeyFor(meId, otherId);
  try {
    const conversation = await prisma.conversation.upsert({
      where: { directKey },
      update: {},
      create: {
        type: "PRIVATE",
        directKey,
        participants: { create: [{ userId: meId }, { userId: otherId }] },
      },
      select: { id: true },
    });
    return conversation.id;
  } catch (err) {
    // Deux créations simultanées : l'une échoue sur la contrainte d'unicité,
    // on relit simplement celle qui a été créée par l'autre.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.conversation.findUniqueOrThrow({ where: { directKey }, select: { id: true } });
      return existing.id;
    }
    throw err;
  }
}

export async function startConversationByPhone(meId: string, phone: string) {
  const other = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (!other) throw notFound("Aucun utilisateur avec ce numéro");
  if (other.id === meId) throw badRequest("Vous ne pouvez pas démarrer une discussion avec vous-même");

  const conversationId = await findOrCreatePrivateConversation(meId, other.id);
  const [summary] = await listConversations(meId, [conversationId]);
  return summary;
}

// Mes conversations (ou seulement certaines si `onlyIds`), de la plus récemment active à la plus ancienne.
export async function listConversations(meId: string, onlyIds?: string[]) {
  const conversations = await prisma.conversation.findMany({
    where: {
      participants: { some: { userId: meId } },
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      type: true,
      name: true,
      updatedAt: true,
      participants: {
        where: { userId: { not: meId } },
        select: { user: { select: publicUserSelect } },
      },
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: messageSelect,
      },
    },
  });

  // Non-lus : messages de la conversation dont MON statut n'est pas encore READ.
  const unread = await prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: conversations.map((c) => c.id) },
      statuses: { some: { userId: meId, status: { not: "READ" } } },
    },
    _count: { _all: true },
  });
  const unreadByConversation = new Map(unread.map((u) => [u.conversationId, u._count._all]));

  return conversations.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    updatedAt: c.updatedAt,
    // En privé : l'autre personne (affiche son nom et sa photo).
    otherUser: c.type === "PRIVATE" ? (c.participants[0]?.user ?? null) : null,
    lastMessage: c.messages[0] ? toMessageDTO(c.messages[0]) : null,
    unreadCount: unreadByConversation.get(c.id) ?? 0,
  }));
}
export type ConversationSummary = Awaited<ReturnType<typeof listConversations>>[number];

// ---------- Messages ----------

// Pagination par curseur : on demande les `limit` messages plus anciens que `before`.
// Plus fiable qu'un numéro de page : l'arrivée de nouveaux messages ne décale rien.
export async function listMessages(
  meId: string,
  conversationId: string,
  { before, limit }: { before?: string; limit: number },
) {
  await assertParticipant(meId, conversationId);

  if (before) {
    const cursor = await prisma.message.findFirst({ where: { id: before, conversationId }, select: { id: true } });
    if (!cursor) throw badRequest("Curseur `before` invalide");
  }

  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], // utilise l'index (conversation_id, created_at DESC)
    take: limit + 1, // un de plus pour savoir s'il reste des messages
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    select: messageSelect,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    messages: page.reverse().map(toMessageDTO), // du plus ancien au plus récent, pour l'affichage
    nextCursor: hasMore ? page[0].id : null,
  };
}

export async function sendMessage(senderId: string, { conversationId, content }: { conversationId: string; content: string }) {
  const participants = await prisma.participant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  if (!participants.some((p) => p.userId === senderId)) throw notFound("Conversation introuvable");
  const recipientIds = participants.map((p) => p.userId).filter((id) => id !== senderId);

  // Transaction : le message, ses statuts et la date d'activité de la conversation
  // sont enregistrés ensemble, ou pas du tout.
  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        senderId,
        type: "TEXT",
        content,
        statuses: { create: recipientIds.map((userId) => ({ userId })) }, // SENT par défaut
      },
      select: messageSelect,
    }),
    prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
  ]);

  return { message: toMessageDTO(message), recipientIds };
}

// ---------- Accusés de réception ----------

// Changement de statut à notifier à un expéditeur.
export interface StatusUpdate {
  senderId: string;
  conversationId: string;
  messageIds: string[];
  userId: string; // le destinataire qui a reçu / lu
  status: DeliveryStatus;
}

// Passe des statuts de `userId` à `status`, UNIQUEMENT vers l'avant
// (un message lu ne redevient jamais « reçu »), et regroupe les changements par expéditeur.
async function advanceStatuses(
  userId: string,
  status: Exclude<DeliveryStatus, "SENT">,
  where: Prisma.MessageStatusWhereInput,
): Promise<StatusUpdate[]> {
  const lowerStatuses = (Object.keys(STATUS_RANK) as DeliveryStatus[]).filter(
    (s) => STATUS_RANK[s] < STATUS_RANK[status],
  );
  const filter: Prisma.MessageStatusWhereInput = { ...where, userId, status: { in: lowerStatuses } };

  const rows = await prisma.messageStatus.findMany({
    where: filter,
    select: { messageId: true, message: { select: { senderId: true, conversationId: true } } },
  });
  if (rows.length === 0) return [];

  await prisma.messageStatus.updateMany({
    where: { ...filter, messageId: { in: rows.map((r) => r.messageId) } },
    data: { status },
  });

  const groups = new Map<string, StatusUpdate>();
  for (const { messageId, message } of rows) {
    const key = `${message.senderId}|${message.conversationId}`;
    const group = groups.get(key) ?? {
      senderId: message.senderId,
      conversationId: message.conversationId,
      messageIds: [],
      userId,
      status,
    };
    group.messageIds.push(messageId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// Messages arrivés sur l'appareil (tous les messages en attente si `messageIds` est absent).
export const markDelivered = (userId: string, messageIds?: string[]) =>
  advanceStatuses(userId, "DELIVERED", messageIds ? { messageId: { in: messageIds } } : {});

// Tous mes messages non lus d'une conversation passent à « lu ».
export const markRead = (userId: string, conversationId: string) =>
  advanceStatuses(userId, "READ", { message: { conversationId } });
