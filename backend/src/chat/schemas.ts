import { z } from "zod";
import { phone } from "../auth/schemas.js";

export const startConversationSchema = z.object({ phone });

export const conversationIdSchema = z.uuid();

export const listMessagesQuerySchema = z.object({
  before: z.uuid().optional(), // id du plus ancien message déjà affiché
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// --- Payloads des événements socket ---

export const sendMessageSchema = z.object({
  conversationId: z.uuid(),
  content: z.string().trim().min(1, "Message vide").max(4096, "Message trop long"),
  // Id temporaire choisi par le client : renvoyé dans l'ack pour remplacer
  // le message affiché « en attente » par le message enregistré.
  clientId: z.string().max(64).optional(),
});

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

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
