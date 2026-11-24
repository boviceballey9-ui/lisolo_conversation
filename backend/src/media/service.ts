// Médias : autorisation d'envoi, enregistrement après envoi, autorisation de lecture.
//
// Parcours d'un fichier :
//   1. le client demande une URL d'envoi   → requestUpload (vérifie type + taille, signe un PUT)
//   2. le navigateur envoie le fichier      → directement à MinIO, le backend n'y touche pas
//   3. le client confirme l'envoi           → registerUpload (revérifie l'objet réel, crée la ligne media)
//   4. le média est attaché à un message / une photo, puis lu via une URL présignée GET (readUrl).

import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { deleteObject, headObject, presignGet, presignPut, PRESIGN_SECONDS } from "../storage.js";
import { baseMime, categoryOf, checkFile, type MediaCategory } from "./rules.js";

export const mediaSelect = { id: true, mimeType: true, size: true, fileName: true } as const;

// Tous les fichiers d'un utilisateur sont rangés sous ce préfixe : la clé dit à qui il appartient.
const userPrefix = (userId: string) => `users/${userId}/`;

// `publicOrigin` : adresse publique par laquelle le client nous joint (derrière Nginx), ou null.
export async function requestUpload(
  userId: string,
  { mimeType, size }: { mimeType: string; size: number },
  publicOrigin: string | null = null,
) {
  const mime = baseMime(mimeType);
  const problem = checkFile(mime, size);
  if (problem) throw badRequest(problem);

  const objectKey = `${userPrefix(userId)}${randomUUID()}`;
  const uploadUrl = await presignPut(objectKey, mime, size, publicOrigin);
  return {
    uploadUrl,
    objectKey,
    expiresIn: PRESIGN_SECONDS,
    // Le navigateur DOIT envoyer exactement ce type : il fait partie de la signature.
    headers: { "Content-Type": mime },
  };
}

export async function registerUpload(userId: string, { objectKey, fileName }: { objectKey: string; fileName?: string }) {
  // On ne peut enregistrer que ses propres fichiers.
  if (!objectKey.startsWith(userPrefix(userId))) throw notFound("Fichier introuvable");

  // L'objet a-t-il vraiment été envoyé ? Et que contient-il VRAIMENT ?
  // (Défense en profondeur : la signature impose déjà type et taille.)
  const head = await headObject(objectKey);
  if (!head) throw badRequest("Fichier non reçu : l'envoi vers le stockage a échoué ou n'est pas terminé");
  const problem = checkFile(head.mimeType, head.size);
  if (problem) {
    await deleteObject(objectKey);
    throw badRequest(problem);
  }

  try {
    return await prisma.media.create({
      data: { objectKey, mimeType: baseMime(head.mimeType), size: head.size, fileName: fileName ?? null, uploaderId: userId },
      select: mediaSelect,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(409, "Fichier déjà enregistré");
    }
    throw err;
  }
}

// Un média que `userId` a lui-même envoyé (pour l'attacher à un message ou à une photo).
// 404 sinon : connaître l'id d'un média ne suffit pas pour se l'approprier.
export async function ownMedia(userId: string, mediaId: string) {
  const media = await prisma.media.findFirst({ where: { id: mediaId, uploaderId: userId }, select: mediaSelect });
  if (!media) throw notFound("Média introuvable");
  return { ...media, category: categoryOf(media.mimeType) as MediaCategory };
}

// Qui peut lire un média ?
// - celui qui l'a envoyé ;
// - les membres d'une conversation où il est attaché à un message, ou dont il est la photo ;
// - tout utilisateur connecté s'il s'agit d'une photo de profil.
async function canRead(userId: string, mediaId: string) {
  const inMyConversations = { participants: { some: { userId } } };
  const media = await prisma.media.findFirst({
    where: {
      id: mediaId,
      OR: [
        { uploaderId: userId },
        { messages: { some: { conversation: inMyConversations } } },
        { conversationPhotos: { some: inMyConversations } },
        { userAvatars: { some: {} } },
      ],
    },
    select: { objectKey: true, fileName: true, mimeType: true },
  });
  return media;
}

export async function readUrl(userId: string, mediaId: string, publicOrigin: string | null = null) {
  const media = await canRead(userId, mediaId);
  // 404 et non 403 : on ne confirme même pas que le fichier existe.
  if (!media) throw notFound("Média introuvable");
  const isDocument = categoryOf(media.mimeType) === "DOCUMENT";
  const url = await presignGet(media.objectKey, { fileName: isDocument ? media.fileName : null, publicOrigin });
  return { url, expiresAt: new Date(Date.now() + PRESIGN_SECONDS * 1000) };
}
