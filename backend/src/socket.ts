import type http from "node:http";
import { Server, type Socket } from "socket.io";
import type { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";
import { deliveredSchema, presenceGetSchema, readSchema, sendMessageSchema, typingSchema } from "./chat/schemas.js";
import {
  contactIds,
  lastSeenOf,
  markDelivered,
  markRead,
  participantIdsFor,
  sendMessage,
  setLastSeen,
  type StatusUpdate,
} from "./chat/service.js";
import { HttpError } from "./errors.js";

// Room personnelle d'un utilisateur : tous ses onglets / appareils connectés y sont.
// Pour envoyer quelque chose à un utilisateur, on émet vers sa room.
export const userRoom = (userId: string) => `user:${userId}`;

type Ack = (response: { ok: boolean; error?: string; [key: string]: unknown }) => void;

export interface SocketOptions {
  // Délai après lequel « en train d'écrire » s'arrête tout seul sans nouveau typing:start.
  typingTimeoutMs?: number;
}

// État « en train d'écrire » d'un utilisateur dans une conversation.
interface TypingEntry {
  timer: NodeJS.Timeout;
  socketId: string; // dernier onglet qui a signalé la saisie
  recipientIds: string[];
}

export function attachSocket(server: http.Server, { typingTimeoutMs = 3000 }: SocketOptions = {}) {
  const io = new Server(server, { cors: { origin: true } });

  // ---------- État en mémoire (propre à ce serveur) ----------
  // Nombre de connexions ouvertes par utilisateur : un utilisateur avec 2 onglets
  // n'est « hors ligne » que quand le DERNIER se ferme.
  const connections = new Map<string, number>();
  // Clé "<userId>:<conversationId>".
  const typing = new Map<string, TypingEntry>();

  // Authentification au moment de la connexion (handshake) :
  // le client envoie son access token dans `auth.token`. Sans token valide, connexion refusée.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      if (typeof token !== "string") throw new Error();
      socket.data.userId = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  // Prévient chaque expéditeur que ses messages ont été reçus / lus.
  const notifySenders = (updates: StatusUpdate[]) => {
    for (const { senderId, conversationId, messageIds, userId, status } of updates) {
      io.to(userRoom(senderId)).emit("message:status", { conversationId, messageIds, userId, status });
    }
  };

  // ---------- Présence ----------

  const broadcastPresence = async (userId: string, online: boolean, lastSeenAt: Date | null) => {
    for (const contactId of await contactIds(userId)) {
      io.to(userRoom(contactId)).emit("presence:update", { userId, online, lastSeenAt });
    }
  };

  const onUserConnected = async (userId: string) => {
    const count = (connections.get(userId) ?? 0) + 1;
    connections.set(userId, count);
    if (count === 1) await broadcastPresence(userId, true, null); // premier onglet : en ligne
  };

  const onUserDisconnected = async (userId: string) => {
    const count = (connections.get(userId) ?? 1) - 1;
    if (count > 0) {
      connections.set(userId, count); // il reste d'autres onglets ouverts
      return;
    }
    connections.delete(userId);
    const lastSeenAt = await setLastSeen(userId);
    // Pendant l'écriture en base, l'utilisateur a pu se reconnecter (rechargement de page) :
    // dans ce cas il est en ligne, on n'annonce surtout pas « hors ligne ».
    if (connections.has(userId)) return;
    await broadcastPresence(userId, false, lastSeenAt);
  };

  // ---------- Saisie (« en train d'écrire ») ----------

  const typingKey = (userId: string, conversationId: string) => `${userId}:${conversationId}`;

  const emitTyping = (userId: string, conversationId: string, recipientIds: string[], isTyping: boolean) => {
    for (const recipientId of recipientIds) {
      io.to(userRoom(recipientId)).emit("typing:update", { conversationId, userId, isTyping });
    }
  };

  const stopTyping = (userId: string, conversationId: string) => {
    const key = typingKey(userId, conversationId);
    const entry = typing.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    typing.delete(key);
    emitTyping(userId, conversationId, entry.recipientIds, false);
  };

  const startTyping = async (userId: string, conversationId: string, socketId: string) => {
    const key = typingKey(userId, conversationId);
    const existing = typing.get(key);
    // Déjà en train d'écrire : on relance juste le minuteur, sans requête ni nouvel événement.
    const recipientIds =
      existing?.recipientIds ??
      (await participantIdsFor(userId, conversationId)).filter((id) => id !== userId);

    if (existing) clearTimeout(existing.timer);
    // Arrêt automatique si le client n'envoie plus rien (onglet fermé brutalement,
    // réseau coupé, utilisateur qui s'arrête de taper sans envoyer).
    const timer = setTimeout(() => stopTyping(userId, conversationId), typingTimeoutMs);
    typing.set(key, { timer, socketId, recipientIds });
    if (!existing) emitTyping(userId, conversationId, recipientIds, true);
  };

  // ---------- Connexion d'un socket ----------

  io.on("connection", (socket) => {
    const userId: string = socket.data.userId;
    socket.join(userRoom(userId));

    // Envoi d'un message : enregistrement, ack à l'émetteur, diffusion au destinataire.
    handle(socket, "message:send", sendMessageSchema, async ({ conversationId, content, clientId }) => {
      const { message, recipientIds } = await sendMessage(userId, { conversationId, content });
      stopTyping(userId, conversationId); // le message est parti : on n'écrit plus
      for (const recipientId of recipientIds) {
        io.to(userRoom(recipientId)).emit("message:new", message);
      }
      // Mes autres onglets / appareils (socket.to exclut le socket émetteur).
      socket.to(userRoom(userId)).emit("message:new", message);
      return { message, clientId };
    });

    // Le client confirme avoir reçu des messages (✓✓).
    handle(socket, "message:delivered", deliveredSchema, async ({ messageIds }) => {
      notifySenders(await markDelivered(userId, messageIds));
      return {};
    });

    // Le client a affiché la conversation : tout est lu (✓✓ bleu).
    handle(socket, "message:read", readSchema, async ({ conversationId }) => {
      notifySenders(await markRead(userId, conversationId));
      return {};
    });

    handle(socket, "typing:start", typingSchema, async ({ conversationId }) => {
      await startTyping(userId, conversationId, socket.id);
      return {};
    });

    handle(socket, "typing:stop", typingSchema, async ({ conversationId }) => {
      stopTyping(userId, conversationId);
      return {};
    });

    // État de présence actuel de mes contacts (à l'ouverture de l'app, après une reconnexion).
    // Les ids qui ne sont pas des contacts sont ignorés : on ne révèle rien aux inconnus.
    handle(socket, "presence:get", presenceGetSchema, async ({ userIds }) => {
      const contacts = new Set(await contactIds(userId));
      const allowed = userIds.filter((id) => contacts.has(id));
      const lastSeen = await lastSeenOf(allowed);
      return {
        presence: allowed.map((id) => ({
          userId: id,
          online: connections.has(id),
          lastSeenAt: lastSeen.get(id) ?? null,
        })),
      };
    });

    socket.on("disconnect", () => {
      // Arrête les saisies signalées par CET onglet.
      for (const [key, entry] of typing) {
        if (entry.socketId === socket.id) stopTyping(userId, key.slice(userId.length + 1));
      }
      onUserDisconnected(userId).catch((err) => console.error(err));
    });

    // Après l'enregistrement des handlers (pour ne manquer aucun événement) :
    // - je suis en ligne ;
    // - les messages reçus pendant que j'étais hors ligne passent à « reçu ».
    onUserConnected(userId).catch((err) => console.error(err));
    markDelivered(userId).then(notifySenders, (err) => console.error(err));
  });

  return io;
}

// Enregistre un handler d'événement : valide le payload avec Zod, exécute,
// et répond via l'ack. Une erreur ne fait jamais tomber le serveur.
function handle<S extends z.ZodType>(
  socket: Socket,
  event: string,
  schema: S,
  fn: (data: z.infer<S>) => Promise<Record<string, unknown>>,
) {
  socket.on(event, async (payload: unknown, ack?: Ack) => {
    const reply: Ack = typeof ack === "function" ? ack : () => {};
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return reply({ ok: false, error: parsed.error.issues[0]?.message ?? "Données invalides" });
    }
    try {
      reply({ ok: true, ...(await fn(parsed.data)) });
    } catch (err) {
      if (err instanceof HttpError) return reply({ ok: false, error: err.message });
      console.error(err);
      reply({ ok: false, error: "Erreur interne du serveur" });
    }
  });
}
