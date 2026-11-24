// Appels audio / vidéo 1-à-1.
//
// Deux canaux, deux rôles :
//  - Socket.io (notre serveur) : la SONNERIE. Inviter, décrocher, refuser, raccrocher, occupé, manqué.
//  - PeerJS (PeerServer + WebRTC) : la CONNEXION entre les deux navigateurs, une fois décroché.
//    Le son et l'image vont directement d'un navigateur à l'autre (ou via le relais TURN).
//
// PeerServer n'accepte qu'UNE connexion par id (= id utilisateur) : le Peer est créé au moment
// de l'appel et détruit à la fin, pour ne pas bloquer les autres onglets.

import Peer, { type MediaConnection } from "peerjs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { getIceConfig, tokens, type CallInfo, type CallType, type User } from "../api";
import { startRingtone, stopRingtone } from "./ringtone";

export type CallPhase = "outgoing" | "incoming" | "connecting" | "active" | "ended";

export interface CallParty {
  id: string;
  name: string;
  avatarId: string | null;
}

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  type: CallType;
  other: CallParty;
  outgoing: boolean;
  answeredAt: number | null; // début de la conversation (pour la durée)
  micOn: boolean;
  camOn: boolean;
  notice: string | null; // « Occupé », « Accès à la caméra refusé »…
}

const ENDED_DISPLAY_MS = 2000;

// Caméra + micro. Si la caméra est refusée ou absente, on continue en audio seul.
async function getLocalMedia(type: CallType): Promise<{ stream: MediaStream; camOn: boolean; warning?: string }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Ce navigateur ne permet pas les appels");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "VIDEO" });
    return { stream, camOn: type === "VIDEO" };
  } catch (err) {
    if (type === "VIDEO") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return { stream, camOn: false, warning: "Caméra indisponible ou refusée : appel sans vidéo" };
      } catch {
        /* on tombe sur l'erreur ci-dessous */
      }
    }
    const name = err instanceof DOMException ? err.name : "";
    throw new Error(
      name === "NotAllowedError"
        ? "Accès au micro refusé : autorisez-le dans les réglages du navigateur"
        : "Aucun micro disponible",
    );
  }
}

// Crée notre Peer (id = notre id utilisateur, authentifié par l'access token) et attend qu'il soit prêt.
async function openPeer(meId: string): Promise<Peer> {
  const { iceServers } = await getIceConfig(); // renouvelle aussi l'access token si besoin
  const secure = location.protocol === "https:";
  const peer = new Peer(meId, {
    host: location.hostname,
    port: Number(location.port) || (secure ? 443 : 80),
    path: "/peerjs",
    secure,
    token: tokens.access ?? "", // vérifié par le serveur : JWT valide ET sub === meId
    config: { iceServers },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Serveur d'appel injoignable")), 10_000);
    peer.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    peer.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(err.type === "unavailable-id" ? "Un appel est déjà ouvert dans un autre onglet" : "Serveur d'appel injoignable"),
      );
    });
  });
  return peer;
}

interface Ack {
  ok: boolean;
  error?: string;
  call?: CallInfo;
  reason?: "OFFLINE" | "BUSY";
}

export function useCall(socket: Socket | null, me: User | null) {
  const [state, setState] = useState<CallState | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // Ressources de l'appel en cours (lues dans les handlers socket, d'où des refs).
  const stateRef = useRef(state);
  stateRef.current = state;
  const peerRef = useRef<Peer | null>(null);
  const connectionRef = useRef<MediaConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = (update: Partial<CallState>) => setState((s) => (s ? { ...s, ...update } : s));

  // Libère tout : micro, caméra, connexion WebRTC, Peer (l'id redevient libre), sonnerie.
  const release = useCallback(() => {
    stopRingtone();
    connectionRef.current?.close();
    connectionRef.current = null;
    peerRef.current?.destroy();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
  }, []);

  // Termine l'affichage : message éventuel pendant 2 s, puis plus rien.
  const finish = useCallback(
    (notice: string | null) => {
      release();
      if (endTimer.current) clearTimeout(endTimer.current);
      if (!notice) return setState(null);
      setState((s) => (s ? { ...s, phase: "ended", notice } : s));
      endTimer.current = setTimeout(() => setState(null), ENDED_DISPLAY_MS);
    },
    [release],
  );

  const keepStream = (stream: MediaStream) => {
    streamRef.current = stream;
    setLocalStream(stream);
  };

  // Branche la connexion WebRTC : quand le flux distant arrive, l'appel est « en cours ».
  const watchConnection = useCallback(
    (connection: MediaConnection) => {
      connectionRef.current = connection;
      connection.on("stream", (remote) => {
        setRemoteStream(remote);
        setState((s) => (s ? { ...s, phase: "active", answeredAt: s.answeredAt ?? Date.now() } : s));
      });
      connection.on("close", () => {
        const current = stateRef.current;
        if (current?.callId && current.phase !== "ended") {
          socket?.emit("call:end", { callId: current.callId });
          finish("Appel terminé");
        }
      });
      connection.on("error", () => finish("Connexion perdue"));
    },
    [finish, socket],
  );

  // ---------- Appeler ----------

  const startCall = useCallback(
    async (conversationId: string, other: CallParty, type: CallType) => {
      if (!socket || !me || stateRef.current) return;
      setState({
        phase: "outgoing",
        callId: null,
        type,
        other,
        outgoing: true,
        answeredAt: null,
        micOn: true,
        camOn: type === "VIDEO",
        notice: null,
      });
      try {
        const media = await getLocalMedia(type);
        if (!stateRef.current) return media.stream.getTracks().forEach((t) => t.stop());
        keepStream(media.stream);
        patch({ camOn: media.camOn, notice: media.warning ?? null });
        const peer = await openPeer(me.id); // prêt AVANT de faire sonner
        if (!stateRef.current) return peer.destroy(); // raccroché pendant la préparation
        peerRef.current = peer;

        const ack: Ack = await socket.timeout(10_000).emitWithAck("call:invite", { conversationId, type });
        if (!ack.ok || !ack.call) throw new Error(ack.error ?? "Appel impossible");
        if (!stateRef.current) {
          // Raccroché pendant que ça partait : on annule tout de suite côté serveur.
          socket.emit("call:end", { callId: ack.call.id });
          return release();
        }
        if (ack.reason === "OFFLINE") return finish(`${other.name} est hors ligne`);
        if (ack.reason === "BUSY") return finish(`${other.name} est déjà en ligne`);
        patch({ callId: ack.call.id });
        startRingtone("outgoing");
      } catch (err) {
        finish(err instanceof Error ? err.message : "Appel impossible");
      }
    },
    [socket, me, finish, release],
  );

  // ---------- Recevoir ----------

  const accept = useCallback(async () => {
    const current = stateRef.current;
    if (!socket || !me || !current?.callId || current.phase !== "incoming") return;
    stopRingtone();
    patch({ phase: "connecting" });
    try {
      const media = await getLocalMedia(current.type);
      keepStream(media.stream);
      patch({ camOn: media.camOn, notice: media.warning ?? null });
      const peer = await openPeer(me.id);
      peerRef.current = peer;
      // L'appelant va nous « composer » via PeerJS dès qu'il saura qu'on a décroché.
      peer.on("call", (connection) => {
        connection.answer(media.stream);
        watchConnection(connection);
      });
      const ack: Ack = await socket.timeout(10_000).emitWithAck("call:accept", { callId: current.callId });
      if (!ack.ok) throw new Error(ack.error ?? "Impossible de décrocher");
    } catch (err) {
      // Micro refusé, serveur injoignable… : on libère l'appelant au lieu de le laisser sonner.
      socket.emit("call:reject", { callId: current.callId });
      finish(err instanceof Error ? err.message : "Impossible de décrocher");
    }
  }, [socket, me, finish, watchConnection]);

  const reject = useCallback(() => {
    const current = stateRef.current;
    if (current?.callId) socket?.emit("call:reject", { callId: current.callId });
    finish(null);
  }, [socket, finish]);

  const hangUp = useCallback(() => {
    const current = stateRef.current;
    if (current?.callId) socket?.emit("call:end", { callId: current.callId });
    finish(current?.phase === "active" ? "Appel terminé" : null);
  }, [socket, finish]);

  // Couper le micro / la caméra : on désactive la piste (l'autre reçoit du silence / du noir).
  const toggleMic = useCallback(() => {
    const on = !stateRef.current?.micOn;
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = on));
    patch({ micOn: on });
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = streamRef.current?.getVideoTracks() ?? [];
    if (tracks.length === 0) return; // appel audio, ou caméra refusée
    const on = !stateRef.current?.camOn;
    tracks.forEach((t) => (t.enabled = on));
    patch({ camOn: on });
  }, []);

  // ---------- Événements de sonnerie (Socket.io) ----------

  useEffect(() => {
    if (!socket || !me) return;

    const onInvite = ({ call, caller }: { call: CallInfo; caller: User }) => {
      if (stateRef.current) return; // déjà occupé dans cet onglet (le serveur gère « occupé » entre utilisateurs)
      setState({
        phase: "incoming",
        callId: call.id,
        type: call.type,
        other: { id: caller.id, name: caller.name, avatarId: caller.avatarId },
        outgoing: false,
        answeredAt: null,
        micOn: true,
        camOn: call.type === "VIDEO",
        notice: null,
      });
      startRingtone("incoming");
    };

    const onAccept = ({ call }: { call: CallInfo }) => {
      const current = stateRef.current;
      if (!current || current.callId !== call.id) return;
      if (current.phase === "incoming") return finish(null); // décroché dans un AUTRE onglet : on se tait
      if (current.outgoing && peerRef.current && streamRef.current) {
        // L'appelé a décroché (et son Peer est prêt) : on établit la connexion WebRTC.
        stopRingtone();
        patch({ phase: "connecting" });
        watchConnection(peerRef.current.call(call.calleeId!, streamRef.current, { metadata: { callId: call.id } }));
      }
    };

    const onEnd = ({ call }: { call: CallInfo }) => {
      const current = stateRef.current;
      if (!current || current.callId !== call.id || current.phase === "ended") return;
      const notice: Record<string, string | null> = {
        REJECTED: current.outgoing ? "Appel refusé" : null,
        MISSED: current.outgoing ? "Pas de réponse" : null,
        COMPLETED: "Appel terminé",
      };
      finish(notice[call.status] ?? null);
    };

    const onBusy = ({ call }: { call: CallInfo }) => {
      const current = stateRef.current;
      if (current?.outgoing && (!current.callId || current.callId === call.id)) finish(`${current.other.name} est déjà en ligne`);
    };

    socket.on("call:invite", onInvite);
    socket.on("call:accept", onAccept);
    socket.on("call:reject", onEnd);
    socket.on("call:end", onEnd);
    socket.on("call:busy", onBusy);
    return () => {
      socket.off("call:invite", onInvite);
      socket.off("call:accept", onAccept);
      socket.off("call:reject", onEnd);
      socket.off("call:end", onEnd);
      socket.off("call:busy", onBusy);
    };
  }, [socket, me, finish, watchConnection]);

  // Page quittée pendant un appel : on libère micro et caméra.
  useEffect(() => () => release(), [release]);

  return { state, localStream, remoteStream, startCall, accept, reject, hangUp, toggleMic, toggleCamera };
}
