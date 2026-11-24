import type http from "node:http";
import { Server } from "socket.io";
import { verifyAccessToken } from "./auth/tokens.js";
import { config } from "./config.js";
import { deliveredSchema, presenceGetSchema, readSchema, sendMessageSchema, typingSchema } from "./chat/schemas.js";
import type { GroupEffects } from "./chat/groups.js";
import {
  contactIds,
  groupIdsOf,
  lastSeenOf,
  markDelivered,
  markRead,
  participantIdsFor,
  sendMessage,
  setLastSeen,
  type StatusUpdate,
} from "./chat/service.js";
import { createCallManager } from "./calls/socketCalls.js";
import { notifyNewMessage, webPushSender, type PushSender } from "./push/service.js";
import { groupRoom, userRoom } from "./rooms.js";
import { handle } from "./socketHandle.js";

export { groupRoom, userRoom }; // réexportés pour les modules existants

export interface SocketOptions {
  // Délai après lequel « en train d'écrire » s'arrête tout seul sans nouveau typing:start.
  typingTimeoutMs?: number;
  // Délai de sonnerie avant « appel manqué ».
  callTimeoutMs?: number;
  // Envoi des notifications push (remplacé dans les tests : aucun appel vers Google / Mozilla).
  pushSender?: PushSender;
}

// État « en train d'écrire » d'un utilisateur dans une conversation.
interface TypingEntry {
  timer: NodeJS.Timeout;
  socketId: string; // dernier onglet qui a signalé la saisie
  recipientIds: string[];
}

export function attachSocket(
  server: http.Server,
  { typingTimeoutMs = 3000, callTimeoutMs = 30_000, pushSender = webPushSender }: SocketOptions = {},
) {
  // Même liste d'origines que l'API REST (CORS_ORIGINS).
  const io = new Server(server, {
    cors: { origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) },
  });

  // ---------- État en mémoire (propre à ce serveur) ----------
  // Nombre de connexions ouvertes par utilisateur : un utilisateur avec 2 onglets
  // n'est « hors ligne » que quand le DERNIER se ferme.
  const connections = new Map<string, number>();
  // Clé "<userId>:<conversationId>".
  const typing = new Map<string, TypingEntry>();
  // Appels audio / vidéo : sonnerie, occupé, manqué (voir calls/socketCalls.ts).
  const calls = createCallManager(io, { isOnline: (id) => connections.has(id), callTimeoutMs });

  // Authentification au moment de la connexion (handshake) :
  // le client envoie son access token dans `auth.token`. Sans token valide, connexion refusée.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      if (typeof token !== "string") throw new Error();
      socket.data.userId = verifyAccessToken(token);
    } catch {
      return next(new Error("UNAUTHORIZED"));
    }
    try {
      // Groupes à rejoindre, chargés AVANT la connexion : le socket est dans ses rooms
      // dès le premier instant (rejointes de façon synchrone dans "connection").
      socket.data.groupIds = await groupIdsOf(socket.data.userId);
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  // Prévient chaque expéditeur que ses messages ont été reçus / lus.
  const notifySenders = (updates: StatusUpdate[]) => {
    for (const { senderId, conversationId, messageIds, userId, status, aggregates } of updates) {
      io.to(userRoom(senderId)).emit("message:status", { conversationId, messageIds, userId, status, aggregates });
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
    for (const groupId of socket.data.groupIds as string[]) socket.join(groupRoom(groupId));

    // Envoi d'un message : enregistrement, ack à l'émetteur, diffusion aux destinataires.
    handle(socket, "message:send", sendMessageSchema, async ({ conversationId, content, mediaId, clientId }) => {
      const { message, recipientIds, conversationType } = await sendMessage(userId, { conversationId, content, mediaId });
      stopTyping(userId, conversationId); // le message est parti : on n'écrit plus
      if (conversationType === "GROUP") {
        // Toute la room du groupe : les autres membres ET mes autres onglets.
        // socket.to(...) exclut uniquement le socket émetteur (il a déjà l'ack).
        socket.to(groupRoom(conversationId)).emit("message:new", message);
      } else {
        for (const recipientId of recipientIds) {
          io.to(userRoom(recipientId)).emit("message:new", message);
        }
        socket.to(userRoom(userId)).emit("message:new", message); // mes autres onglets
      }
      // Destinataires sans AUCUN onglet ouvert : notification push (en tâche de fond, l'expéditeur
      // n'attend pas). Ceux qui ont un onglet ouvert ont reçu message:new ; si l'onglet est en
      // arrière-plan, c'est le navigateur qui affiche une notification locale.
      const offline = recipientIds.filter((id) => !connections.has(id));
      if (offline.length > 0) {
        notifyNewMessage(message, conversationType, offline, pushSender).catch((err) => console.error(err));
      }
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

    calls.register(socket);

    socket.on("disconnect", () => {
      calls.onDisconnect(socket); // un appel porté par cet onglet se termine
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

// Diffuse les conséquences d'une action sur un groupe (appelée par les routes HTTP).
export function broadcastGroupEffects(io: Server, effects: GroupEffects) {
  const room = groupRoom(effects.groupId);
  // 1. Les rooms suivent la base : tous les sockets (onglets) des nouveaux membres entrent,
  //    ceux des partants sortent. Sans ça, un membre retiré continuerait de tout recevoir.
  for (const id of effects.joinedIds) io.in(userRoom(id)).socketsJoin(room);
  for (const id of effects.leftIds) {
    io.in(userRoom(id)).socketsLeave(room);
    io.to(userRoom(id)).emit("group:removed", { conversationId: effects.groupId });
  }
  if (effects.deleted) return;
  // 2. Les membres restants voient les messages système et la nouvelle composition.
  for (const message of effects.systemMessages) io.to(room).emit("message:new", message);
  io.to(room).emit("group:updated", {
    conversationId: effects.groupId,
    name: effects.name,
    photoId: effects.photoId,
    members: effects.members,
  });
}
