// Sonnerie des appels, via Socket.io (pas via PeerJS).
//
// Pourquoi pas PeerJS ? Pour sonner, il faut joindre TOUS les onglets de l'appelé, savoir s'il est
// en ligne ou déjà en appel, et enregistrer l'historique : c'est le rôle de notre serveur.
// PeerJS ne sert qu'APRÈS le « décroché », pour établir la connexion WebRTC entre les deux navigateurs.
//
//   appelant                      serveur                          appelé (tous ses onglets)
//   call:invite ───────────────▶  RINGING, minuteur 30 s  ──────▶  call:invite (ça sonne)
//                                                         ◀──────  call:accept (Peer ouvert)
//   call:accept ◀──────────────   ONGOING                 ──────▶  call:accept (les autres onglets se taisent)
//   peer.call(calleeId) ═══════════════ WebRTC (PeerJS) ═══════════  answer()
//   call:end ──────────────────▶  COMPLETED + message CALL ─────▶  call:end

import type { Server, Socket } from "socket.io";
import { callIdSchema, callInviteSchema } from "../chat/schemas.js";
import { badRequest, notFound } from "../errors.js";
import { userRoom } from "../rooms.js";
import { handle } from "../socketHandle.js";
import {
  calleeOf,
  callerProfile,
  createCall,
  finishCall,
  markAnswered,
  type CallType,
  type FinalCallStatus,
} from "./service.js";

interface ActiveCall {
  id: string;
  callerId: string;
  calleeId: string;
  status: "RINGING" | "ONGOING";
  callerSocketId: string; // onglet qui a appelé
  calleeSocketId?: string; // onglet qui a décroché
  timer?: NodeJS.Timeout;
}

interface Options {
  isOnline: (userId: string) => boolean;
  callTimeoutMs: number;
}

export function createCallManager(io: Server, { isOnline, callTimeoutMs }: Options) {
  // État en mémoire (un seul processus) : appels en cours, et appel en cours de chaque utilisateur.
  const calls = new Map<string, ActiveCall>();
  const userCall = new Map<string, string>(); // userId → callId (ou réservation) : sert à « occupé »

  const toBoth = (c: { callerId: string; calleeId: string }) => io.to(userRoom(c.callerId)).to(userRoom(c.calleeId));

  // Fin d'un appel. Idempotent : un appel ne se termine qu'une fois (raccrocher + déconnexion…).
  const finish = async (c: ActiveCall, status: FinalCallStatus) => {
    if (calls.get(c.id) !== c) return;
    calls.delete(c.id);
    clearTimeout(c.timer);
    if (userCall.get(c.callerId) === c.id) userCall.delete(c.callerId);
    if (userCall.get(c.calleeId) === c.id) userCall.delete(c.calleeId);

    const { call, message } = await finishCall(c.id, status);
    toBoth(c).emit(status === "REJECTED" ? "call:reject" : "call:end", { call });
    toBoth(c).emit("message:new", message); // trace de l'appel dans la conversation
  };

  // Appel qui ne sonne même pas (destinataire hors ligne ou occupé) : enregistré directement.
  const recordUnanswered = async (
    base: { conversationId: string; callerId: string; calleeId: string; type: CallType },
    status: "MISSED" | "BUSY",
  ) => {
    const created = await createCall(base);
    const { call, message } = await finishCall(created.id, status);
    toBoth(base).emit("message:new", message);
    return call;
  };

  function register(socket: Socket) {
    const userId: string = socket.data.userId;

    handle(socket, "call:invite", callInviteSchema, async ({ conversationId, type }) => {
      if (userCall.has(userId)) throw badRequest("Vous êtes déjà en appel");
      const calleeId = await calleeOf(userId, conversationId);
      if (userCall.has(userId)) throw badRequest("Vous êtes déjà en appel"); // re-vérifié après l'await
      const base = { conversationId, callerId: userId, calleeId, type };

      if (!isOnline(calleeId)) {
        // Personne pour décrocher : appel manqué immédiat (il le verra dans la conversation).
        return { call: await recordUnanswered(base, "MISSED"), reason: "OFFLINE" };
      }
      if (userCall.has(calleeId)) {
        const call = await recordUnanswered(base, "BUSY");
        io.to(userRoom(userId)).emit("call:busy", { call });
        return { call, reason: "BUSY" };
      }

      // Réservation SYNCHRONE des deux utilisateurs avant l'écriture en base :
      // deux appels simultanés vers la même personne → le second la trouve occupée.
      const reservation = `pending:${socket.id}`;
      userCall.set(userId, reservation);
      userCall.set(calleeId, reservation);
      let created;
      try {
        created = await createCall(base);
      } catch (err) {
        userCall.delete(userId);
        userCall.delete(calleeId);
        throw err;
      }

      const active: ActiveCall = { id: created.id, callerId: userId, calleeId, status: "RINGING", callerSocketId: socket.id };
      calls.set(active.id, active);
      userCall.set(userId, active.id);
      userCall.set(calleeId, active.id);
      // Pas de réponse au bout du délai : appel manqué.
      active.timer = setTimeout(() => finish(active, "MISSED").catch(console.error), callTimeoutMs);

      // Tous les onglets de l'appelé sonnent.
      io.to(userRoom(calleeId)).emit("call:invite", { call: created, caller: await callerProfile(userId) });
      return { call: created };
    });

    // Décrocher : seulement l'appelé, seulement si ça sonne encore.
    handle(socket, "call:accept", callIdSchema, async ({ callId }) => {
      const c = calls.get(callId);
      if (!c || c.calleeId !== userId) throw notFound("Appel introuvable");
      if (c.status !== "RINGING") throw badRequest("Appel déjà décroché");
      c.status = "ONGOING"; // synchrone : un 2e onglet qui décroche en même temps sera refusé
      c.calleeSocketId = socket.id;
      clearTimeout(c.timer);
      const call = await markAnswered(callId);
      // L'appelant lance la connexion WebRTC ; les autres onglets de l'appelé arrêtent de sonner.
      toBoth(c).emit("call:accept", { call });
      return { call };
    });

    handle(socket, "call:reject", callIdSchema, async ({ callId }) => {
      const c = calls.get(callId);
      if (!c || c.calleeId !== userId) throw notFound("Appel introuvable");
      if (c.status !== "RINGING") throw badRequest("Appel déjà décroché");
      await finish(c, "REJECTED");
      return {};
    });

    // Raccrocher (l'un ou l'autre). Pendant la sonnerie : l'appelant annule → manqué ; l'appelé → refusé.
    handle(socket, "call:end", callIdSchema, async ({ callId }) => {
      const c = calls.get(callId);
      if (!c || (c.callerId !== userId && c.calleeId !== userId)) throw notFound("Appel introuvable");
      const status: FinalCallStatus =
        c.status === "ONGOING" ? "COMPLETED" : userId === c.calleeId ? "REJECTED" : "MISSED";
      await finish(c, status);
      return {};
    });
  }

  // Onglet fermé / réseau coupé : l'appel porté par CE socket se termine.
  function onDisconnect(socket: Socket) {
    for (const c of calls.values()) {
      const isCallerTab = c.callerSocketId === socket.id;
      const isCalleeTab = c.calleeSocketId === socket.id;
      if (!isCallerTab && !isCalleeTab) continue;
      finish(c, c.status === "ONGOING" ? "COMPLETED" : "MISSED").catch(console.error);
    }
  }

  return { register, onDisconnect };
}
