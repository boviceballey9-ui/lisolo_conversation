// Logique métier du chat, partagée par les routes HTTP et le serveur Socket.io.
// Ne dépend ni d'Express ni de Socket.io : facile à tester et à réutiliser.

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { publicUserSelect } from "../routes/users.js";

export type DeliveryStatus = "SENT" | "DELIVERED" | "READ";

const STATUS_RANK: Record<DeliveryStatus, number> = { SENT: 0, DELIVERED: 1, READ: 2 };

// Champs lus pour chaque message.
export const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  sender: { select: { name: true } }, // affiché au-dessus des bulles dans un groupe
  type: true,
  content: true,
  createdAt: true,
  statuses: { select: { userId: true, status: true } },
} as const;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

// Statut « global » d'un message = le moins avancé parmi ses destinataires.
// En 1-à-1 : celui de l'unique destinataire. En groupe : ✓✓ bleu seulement quand TOUS ont lu.
export function aggregateStatus(statuses: { status: DeliveryStatus }[]): DeliveryStatus {
  if (statuses.length === 0) return "SENT";
  return statuses.reduce<DeliveryStatus>(
    (min, s) => (STATUS_RANK[s.status] < STATUS_RANK[min] ? s.status : min),
    "READ",
  );
}

// Forme envoyée au client. `status` donne ✓ / ✓✓ / ✓✓ bleu.
export function toMessageDTO(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.sender.name,
    type: m.type,
    content: m.content,
    createdAt: m.createdAt,
    status: aggregateStatus(m.statuses),
  };
}
export type MessageDTO = ReturnType<typeof toMessageDTO>;

// Un membre de groupe, tel qu'envoyé au client.
export const memberSelect = {
  role: true,
  joinedAt: true,
  user: { select: publicUserSelect },
} as const;
// Les plus anciens d'abord (sert aussi à choisir le prochain admin).
export const memberOrder: Prisma.ParticipantOrderByWithRelationInput[] = [{ joinedAt: "asc" }, { userId: "asc" }];

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
      participants: { orderBy: memberOrder, select: memberSelect },
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
    otherUser: c.type === "PRIVATE" ? (c.participants.find((p) => p.user.id !== meId)?.user ?? null) : null,
    // En groupe : tous les membres, moi compris (pour connaître mon rôle).
    members: c.type === "GROUP" ? c.participants : null,
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
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true, participants: { select: { userId: true } } },
  });
  const participants = conversation?.participants ?? [];
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

  return { message: toMessageDTO(message), recipientIds, conversationType: conversation!.type };
}

// « Infos du message » : qui l'a reçu, qui l'a lu, et quand. Réservé à l'expéditeur.
export async function getMessageInfo(meId: string, conversationId: string, messageId: string) {
  await assertParticipant(meId, conversationId);
  const row = await prisma.message.findFirst({
    where: { id: messageId, conversationId, senderId: meId },
    select: {
      ...messageSelect,
      statuses: {
        select: { userId: true, status: true, deliveredAt: true, readAt: true, user: { select: publicUserSelect } },
      },
    },
  });
  if (!row) throw notFound("Message introuvable");
  const recipients = row.statuses
    .map(({ user, status, deliveredAt, readAt }) => ({ user, status, deliveredAt, readAt }))
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
  return { message: toMessageDTO(row), recipients };
}

// ---------- Présence ----------

// Mes « contacts » : les personnes avec qui je partage au moins une conversation.
// Ce sont elles (et seulement elles) qui voient si je suis en ligne.
export async function contactIds(userId: string): Promise<string[]> {
  const rows = await prisma.participant.findMany({
    where: { userId: { not: userId }, conversation: { participants: { some: { userId } } } },
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.map((r) => r.userId);
}

// Ids des participants d'une conversation (lève une 404 si `userId` n'en fait pas partie).
export async function participantIdsFor(userId: string, conversationId: string): Promise<string[]> {
  const rows = await prisma.participant.findMany({ where: { conversationId }, select: { userId: true } });
  const ids = rows.map((r) => r.userId);
  if (!ids.includes(userId)) throw notFound("Conversation introuvable");
  return ids;
}

// Groupes dont l'utilisateur est membre (rooms Socket.io à rejoindre à la connexion).
export async function groupIdsOf(userId: string): Promise<string[]> {
  const rows = await prisma.participant.findMany({
    where: { userId, conversation: { type: "GROUP" } },
    select: { conversationId: true },
  });
  return rows.map((r) => r.conversationId);
}

export async function setLastSeen(userId: string): Promise<Date> {
  const lastSeenAt = new Date();
  // updateMany : ne lève pas d'erreur si le compte a été supprimé entre-temps.
  await prisma.user.updateMany({ where: { id: userId }, data: { lastSeenAt } });
  return lastSeenAt;
}

export async function lastSeenOf(userIds: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, lastSeenAt: true } });
  return new Map(users.map((u) => [u.id, u.lastSeenAt]));
}

// ---------- Accusés de réception ----------

// Changement de statut à notifier à un expéditeur.
export interface StatusUpdate {
  senderId: string;
  conversationId: string;
  messageIds: string[];
  userId: string; // le destinataire qui a reçu / lu
  status: DeliveryStatus; // SON statut
  // Statut global de chaque message après ce changement (ce qu'affichent les coches).
  // En groupe, Bob qui lit ne rend pas le message bleu si Carole ne l'a pas encore lu.
  aggregates: { id: string; status: DeliveryStatus }[];
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

  // On horodate chaque étape. Un message lu directement depuis SENT a forcément été
  // reçu au même moment : on remplit aussi deliveredAt.
  const now = new Date();
  const ids = rows.map((r) => r.messageId);
  const base = { ...filter, messageId: { in: ids } };
  if (status === "DELIVERED") {
    await prisma.messageStatus.updateMany({ where: base, data: { status, deliveredAt: now } });
  } else {
    await prisma.$transaction([
      prisma.messageStatus.updateMany({
        where: { ...base, status: "SENT" },
        data: { status, deliveredAt: now, readAt: now },
      }),
      prisma.messageStatus.updateMany({ where: { ...base, status: "DELIVERED" }, data: { status, readAt: now } }),
    ]);
  }

  // Statut global de chaque message touché, en tenant compte des AUTRES destinataires.
  const all = await prisma.messageStatus.findMany({
    where: { messageId: { in: ids } },
    select: { messageId: true, status: true },
  });
  const byMessage = new Map<string, { status: DeliveryStatus }[]>();
  for (const s of all) byMessage.set(s.messageId, [...(byMessage.get(s.messageId) ?? []), s]);

  const groups = new Map<string, StatusUpdate>();
  for (const { messageId, message } of rows) {
    const key = `${message.senderId}|${message.conversationId}`;
    const group = groups.get(key) ?? {
      senderId: message.senderId,
      conversationId: message.conversationId,
      messageIds: [],
      userId,
      status,
      aggregates: [],
    };
    group.messageIds.push(messageId);
    group.aggregates.push({ id: messageId, status: aggregateStatus(byMessage.get(messageId) ?? []) });
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
