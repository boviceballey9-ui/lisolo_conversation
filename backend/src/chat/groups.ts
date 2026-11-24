// Discussions de groupe : création, membres, rôles, départs.
//
// Toutes les règles de permission sont vérifiées ICI, côté serveur. L'interface masque
// les boutons interdits par confort, mais c'est ce fichier qui fait foi.

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { listConversations, memberOrder, memberSelect, messageSelect, toMessageDTO, type MessageDTO } from "./service.js";

type Tx = Prisma.TransactionClient;
export type Member = Prisma.ParticipantGetPayload<{ select: typeof memberSelect }>;

// Ce qu'une action sur un groupe a changé : la couche temps réel (socket.ts) s'en sert
// pour mettre à jour les rooms et prévenir les membres.
export interface GroupEffects {
  groupId: string;
  name: string | null;
  members: Member[]; // instantané après l'action
  systemMessages: MessageDTO[];
  joinedIds: string[]; // à faire entrer dans la room group:<id>
  leftIds: string[]; // à faire sortir de la room
  deleted: boolean; // plus aucun membre : le groupe a été supprimé
}

// ---------- Outils internes ----------

// Transaction + verrou sur la ligne du groupe. Deux actions simultanées sur le MÊME groupe
// s'exécutent l'une après l'autre : sans ça, deux admins qui quittent en même temps
// verraient chacun « il reste un autre admin », et le groupe finirait sans admin.
function withGroupLock<T>(groupId: string, fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${groupId}::uuid FOR UPDATE`;
    return fn(tx);
  });
}

// Membre du groupe ? Sinon 404 : on ne révèle pas l'existence d'un groupe à un non-membre.
async function loadMembership(tx: Tx, userId: string, groupId: string) {
  const membership = await tx.participant.findUnique({
    where: { conversationId_userId: { conversationId: groupId, userId } },
    select: { role: true, user: { select: { name: true } }, conversation: { select: { type: true } } },
  });
  if (!membership || membership.conversation.type !== "GROUP") throw notFound("Groupe introuvable");
  return membership;
}

// Membre ET admin ? Sinon 403 : il sait que le groupe existe (il en fait partie), mais n'a pas le droit.
async function requireAdmin(tx: Tx, userId: string, groupId: string) {
  const membership = await loadMembership(tx, userId, groupId);
  if (membership.role !== "ADMIN") throw forbidden("Réservé aux administrateurs du groupe");
  return membership;
}

async function findTarget(tx: Tx, groupId: string, userId: string) {
  const target = await tx.participant.findUnique({
    where: { conversationId_userId: { conversationId: groupId, userId } },
    select: { role: true, user: { select: { name: true } } },
  });
  if (!target) throw notFound("Cette personne ne fait pas partie du groupe");
  return target;
}

// Numéros → utilisateurs. Un seul numéro inconnu fait échouer toute l'action.
async function usersByPhones(tx: Tx, phones: string[]) {
  const unique = [...new Set(phones)];
  const users = await tx.user.findMany({ where: { phone: { in: unique } }, select: { id: true, name: true, phone: true } });
  const missing = unique.find((p) => !users.some((u) => u.phone === p));
  if (missing) throw notFound(`Aucun utilisateur avec le numéro ${missing}`);
  return users;
}

// "Bob" ; "Bob et Carole" ; "Bob, Carole et David"
const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;

// Dans PostgreSQL, now() vaut l'heure de DÉBUT de la transaction : deux messages système
// créés dans la même transaction auraient la même date, donc un ordre d'affichage aléatoire.
// On fixe nous-mêmes des dates strictement croissantes.
let lastSystemTimestamp = 0;
const nextSystemTimestamp = () => {
  lastSystemTimestamp = Math.max(Date.now(), lastSystemTimestamp + 1);
  return new Date(lastSystemTimestamp);
};

// Message système : type SYSTEM, AUCUN statut de livraison (ni coches, ni « non lu »).
async function systemMessage(tx: Tx, groupId: string, actorId: string, content: string) {
  const message = await tx.message.create({
    data: { conversationId: groupId, senderId: actorId, type: "SYSTEM", content, createdAt: nextSystemTimestamp() },
    select: messageSelect,
  });
  return toMessageDTO(message);
}

// Un membre qui part n'a pas à bloquer le ✓✓ bleu des messages qu'il n'a pas lus :
// on supprime ses statuts non lus. Ceux qu'il a lus restent (« Infos du message »).
const dropPendingStatuses = (tx: Tx, groupId: string, userId: string) =>
  tx.messageStatus.deleteMany({ where: { userId, status: { not: "READ" }, message: { conversationId: groupId } } });

async function snapshot(
  tx: Tx,
  groupId: string,
  partial: Pick<GroupEffects, "systemMessages"> & Partial<Pick<GroupEffects, "joinedIds" | "leftIds">>,
): Promise<GroupEffects> {
  const group = await tx.conversation.update({
    where: { id: groupId },
    data: { updatedAt: new Date() }, // remonte en haut des listes
    select: { name: true, participants: { orderBy: memberOrder, select: memberSelect } },
  });
  return {
    groupId,
    name: group.name,
    members: group.participants,
    joinedIds: [],
    leftIds: [],
    deleted: false,
    ...partial,
  };
}

// ---------- Actions ----------

export async function createGroup(creatorId: string, { name, phones }: { name: string; phones: string[] }) {
  const effects = await prisma.$transaction(async (tx) => {
    const creator = await tx.user.findUniqueOrThrow({ where: { id: creatorId }, select: { name: true } });
    const others = (await usersByPhones(tx, phones)).filter((u) => u.id !== creatorId);
    if (others.length === 0) throw badRequest("Ajoutez au moins une autre personne");

    const group = await tx.conversation.create({
      data: {
        type: "GROUP",
        name,
        participants: {
          create: [{ userId: creatorId, role: "ADMIN" }, ...others.map((u) => ({ userId: u.id, role: "MEMBER" as const }))],
        },
      },
      select: { id: true },
    });
    const message = await systemMessage(tx, group.id, creatorId, `${creator.name} a créé le groupe « ${name} »`);
    return snapshot(tx, group.id, { systemMessages: [message], joinedIds: [creatorId, ...others.map((u) => u.id)] });
  });

  const [conversation] = await listConversations(creatorId, [effects.groupId]);
  return { conversation, effects };
}

export function addMembers(adminId: string, groupId: string, phones: string[]) {
  return withGroupLock(groupId, async (tx) => {
    const admin = await requireAdmin(tx, adminId, groupId);
    const current = await tx.participant.findMany({ where: { conversationId: groupId }, select: { userId: true } });
    const known = new Set(current.map((p) => p.userId));
    const added = (await usersByPhones(tx, phones)).filter((u) => !known.has(u.id));
    if (added.length === 0) throw badRequest("Ces personnes font déjà partie du groupe");

    await tx.participant.createMany({ data: added.map((u) => ({ conversationId: groupId, userId: u.id })) });
    const message = await systemMessage(
      tx,
      groupId,
      adminId,
      `${admin.user.name} a ajouté ${joinNames(added.map((u) => u.name))}`,
    );
    return snapshot(tx, groupId, { systemMessages: [message], joinedIds: added.map((u) => u.id) });
  });
}

export function removeMember(adminId: string, groupId: string, userId: string) {
  return withGroupLock(groupId, async (tx) => {
    const admin = await requireAdmin(tx, adminId, groupId);
    if (userId === adminId) throw badRequest("Pour partir, utilisez « Quitter le groupe »");
    const target = await findTarget(tx, groupId, userId);

    await tx.participant.delete({ where: { conversationId_userId: { conversationId: groupId, userId } } });
    await dropPendingStatuses(tx, groupId, userId);
    const message = await systemMessage(tx, groupId, adminId, `${admin.user.name} a retiré ${target.user.name}`);
    return snapshot(tx, groupId, { systemMessages: [message], leftIds: [userId] });
  });
}

export function promoteAdmin(adminId: string, groupId: string, userId: string) {
  return withGroupLock(groupId, async (tx) => {
    const admin = await requireAdmin(tx, adminId, groupId);
    const target = await findTarget(tx, groupId, userId);
    if (target.role === "ADMIN") throw badRequest("Cette personne est déjà administrateur");

    await tx.participant.update({
      where: { conversationId_userId: { conversationId: groupId, userId } },
      data: { role: "ADMIN" },
    });
    const message = await systemMessage(
      tx,
      groupId,
      adminId,
      `${admin.user.name} a nommé ${target.user.name} administrateur`,
    );
    return snapshot(tx, groupId, { systemMessages: [message] });
  });
}

export function renameGroup(adminId: string, groupId: string, name: string) {
  return withGroupLock(groupId, async (tx) => {
    const admin = await requireAdmin(tx, adminId, groupId);
    await tx.conversation.update({ where: { id: groupId }, data: { name } });
    const message = await systemMessage(tx, groupId, adminId, `${admin.user.name} a renommé le groupe en « ${name} »`);
    return snapshot(tx, groupId, { systemMessages: [message] });
  });
}

export function leaveGroup(userId: string, groupId: string) {
  return withGroupLock(groupId, async (tx): Promise<GroupEffects> => {
    const me = await loadMembership(tx, userId, groupId);
    await tx.participant.delete({ where: { conversationId_userId: { conversationId: groupId, userId } } });
    await dropPendingStatuses(tx, groupId, userId);

    const remaining = await tx.participant.findMany({
      where: { conversationId: groupId },
      orderBy: memberOrder,
      select: { userId: true, role: true, user: { select: { name: true } } },
    });

    // Plus personne : le groupe n'a plus de raison d'exister (messages supprimés en cascade).
    if (remaining.length === 0) {
      await tx.conversation.delete({ where: { id: groupId } });
      return { groupId, name: null, members: [], systemMessages: [], joinedIds: [], leftIds: [userId], deleted: true };
    }

    const messages = [await systemMessage(tx, groupId, userId, `${me.user.name} a quitté le groupe`)];

    // Le dernier admin est parti : le membre le plus ancien prend le relais.
    if (me.role === "ADMIN" && !remaining.some((p) => p.role === "ADMIN")) {
      const heir = remaining[0];
      await tx.participant.update({
        where: { conversationId_userId: { conversationId: groupId, userId: heir.userId } },
        data: { role: "ADMIN" },
      });
      messages.push(await systemMessage(tx, groupId, heir.userId, `${heir.user.name} est maintenant administrateur`));
    }
    return snapshot(tx, groupId, { systemMessages: messages, leftIds: [userId] });
  });
}
