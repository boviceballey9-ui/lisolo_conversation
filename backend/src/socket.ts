import type http from "node:http";
import { Server, type Socket } from "socket.io";
import type { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";
import { deliveredSchema, readSchema, sendMessageSchema } from "./chat/schemas.js";
import { markDelivered, markRead, sendMessage, type StatusUpdate } from "./chat/service.js";
import { HttpError } from "./errors.js";

// Room personnelle d'un utilisateur : tous ses onglets / appareils connectés y sont.
// Pour envoyer quelque chose à un utilisateur, on émet vers sa room.
export const userRoom = (userId: string) => `user:${userId}`;

type Ack = (response: { ok: boolean; error?: string; [key: string]: unknown }) => void;

export function attachSocket(server: http.Server) {
  const io = new Server(server, { cors: { origin: true } });

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

  io.on("connection", (socket) => {
    const userId: string = socket.data.userId;
    socket.join(userRoom(userId));

    // Envoi d'un message : enregistrement, ack à l'émetteur, diffusion au destinataire.
    handle(socket, "message:send", sendMessageSchema, async ({ conversationId, content, clientId }) => {
      const { message, recipientIds } = await sendMessage(userId, { conversationId, content });
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

    // Messages reçus pendant que l'utilisateur était hors ligne : son appareil est
    // maintenant connecté, ils passent à « reçu ». (Après l'enregistrement des handlers,
    // pour ne manquer aucun événement envoyé pendant cette requête.)
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
