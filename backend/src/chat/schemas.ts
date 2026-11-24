import { z } from "zod";
import { phone } from "../auth/schemas.js";

export const startConversationSchema = z.object({ phone });

export const conversationIdSchema = z.uuid();

export const listMessagesQuerySchema = z.object({
  before: z.uuid().optional(), // id du plus ancien message déjà affiché
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// --- Payloads des événements socket ---

export const sendMessageSchema = z
  .object({
    conversationId: z.uuid(),
    content: z.string().trim().max(4096, "Message trop long").optional(),
    // Fichier déjà envoyé à MinIO puis enregistré (POST /api/media).
    mediaId: z.uuid().optional(),
    // Id temporaire choisi par le client : renvoyé dans l'ack pour remplacer
    // le message affiché « en attente » par le message enregistré.
    clientId: z.string().max(64).optional(),
  })
  .refine((m) => !!m.content || !!m.mediaId, { message: "Message vide" });

export const deliveredSchema = z.object({
  messageIds: z.array(z.uuid()).min(1).max(500),
});

export const readSchema = z.object({
  conversationId: z.uuid(),
});

export const typingSchema = z.object({
  conversationId: z.uuid(),
});

export const presenceGetSchema = z.object({
  userIds: z.array(z.uuid()).min(1).max(200),
});

// --- Groupes ---

const groupName = z.string().trim().min(1, "Nom du groupe obligatoire").max(100, "100 caractères maximum");
const memberPhones = z.array(phone).min(1, "Ajoutez au moins un membre").max(256, "256 membres maximum");

export const createGroupSchema = z.object({ name: groupName, phones: memberPhones });
export const renameGroupSchema = z.object({ name: groupName });
export const addMembersSchema = z.object({ phones: memberPhones });
export const promoteAdminSchema = z.object({ userId: z.uuid() });
// null = retirer la photo
export const setPhotoSchema = z.object({ mediaId: z.uuid().nullable() });

// --- Appels ---

export const callInviteSchema = z.object({
  conversationId: z.uuid(),
  type: z.enum(["AUDIO", "VIDEO"]),
});

export const callIdSchema = z.object({ callId: z.uuid() });

// --- Notifications push ---

// Abonnement tel que le renvoie PushSubscription.toJSON() dans le navigateur.
// L'endpoint doit être en HTTPS : c'est l'adresse d'un service push (Google, Mozilla, Apple…).
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((u) => u.startsWith("https://"), "L'adresse du service push doit être en HTTPS"),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) });

// --- Médias ---

export const uploadUrlSchema = z.object({
  mimeType: z.string().min(1).max(255),
  size: z.number().int().positive("Taille invalide"),
  fileName: z.string().trim().max(255).optional(),
});

export const registerMediaSchema = z.object({
  objectKey: z.string().min(1).max(255),
  fileName: z.string().trim().min(1).max(255).optional(),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
