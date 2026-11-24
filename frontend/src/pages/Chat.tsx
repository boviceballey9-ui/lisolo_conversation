import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Socket } from "socket.io-client";
import {
  getMe,
  listConversations,
  listMessages,
  logout,
  setMyAvatar,
  type Conversation,
  type DeliveryStatus,
  type Member,
  type Message,
  type User,
} from "../api";
import { Avatar } from "../components/Avatar";
import { ChatWindow, type ChatMessage } from "../components/ChatWindow";
import { ConversationList } from "../components/ConversationList";
import { GroupInfo } from "../components/GroupInfo";
import { MessageInfo } from "../components/MessageInfo";
import { NewChat } from "../components/NewChat";
import { NewGroup } from "../components/NewGroup";
import { formatLastSeen } from "../format";
import { kindOf, mimeOf, uploadFile } from "../media";
import { CallScreen, IncomingCall } from "../calls/CallScreens";
import { useCall } from "../calls/useCall";
import { createSocket } from "../socket";

// Messages chargés d'une conversation + curseur pour charger les plus anciens.
interface Thread {
  items: ChatMessage[];
  nextCursor: string | null;
}

interface StatusEvent {
  conversationId: string;
  messageIds: string[];
  userId: string;
  status: DeliveryStatus; // statut du destinataire `userId`
  // Statut global de chaque message (en groupe : bleu seulement quand TOUS ont lu).
  aggregates?: { id: string; status: DeliveryStatus }[];
}

interface GroupState {
  name: string | null;
  photoId?: string | null;
  members: Member[];
}

// Panneau latéral ouvert à droite de la conversation.
type Panel = { kind: "group" } | { kind: "message"; messageId: string } | null;

// « Alice écrit… », « Alice et Bob écrivent… », « 3 personnes écrivent… »
function groupTypingLabel(names: string[]) {
  if (names.length === 1) return `${names[0]} écrit…`;
  if (names.length === 2) return `${names[0]} et ${names[1]} écrivent…`;
  return `${names.length} personnes écrivent…`;
}

interface Presence {
  online: boolean;
  lastSeenAt: string | null;
}

interface PresenceEvent extends Presence {
  userId: string;
}

interface TypingEvent {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

const RANK: Record<DeliveryStatus, number> = { SENT: 0, DELIVERED: 1, READ: 2 };

// Pendant la frappe, on renvoie typing:start au plus toutes les 2 s : moins que le délai
// d'arrêt automatique du serveur (3 s), pour qu'il soit relancé tant qu'on tape.
const TYPING_THROTTLE_MS = 2000;

const isVisible = () => document.visibilityState === "visible";

export default function Chat() {
  const navigate = useNavigate();
  const [me, setMe] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  // Incrémenté à chaque accusé reçu : « Infos du message » se recharge.
  const [statusTick, setStatusTick] = useState(0);
  const [connected, setConnected] = useState(false);
  // Le socket, aussi en état (pas seulement en ref) : le hook d'appels doit savoir quand il change.
  const [socket, setSocket] = useState<Socket | null>(null);
  const call = useCall(socket, me);
  // Présence de mes contacts, et qui est en train d'écrire dans quelle conversation.
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [typing, setTyping] = useState<Record<string, string[]>>({});

  // Les handlers du socket sont créés une seule fois : ils lisent l'état courant via ces refs.
  const socketRef = useRef<Socket | null>(null);
  const meRef = useRef(me);
  const activeRef = useRef(activeId);
  const conversationsRef = useRef(conversations);
  const presenceRef = useRef(presence);
  meRef.current = me;
  activeRef.current = activeId;
  conversationsRef.current = conversations;
  presenceRef.current = presence;
  // Dernier typing:start envoyé (pour limiter la fréquence et savoir quoi arrêter).
  const lastTypingEmit = useRef<{ conversationId: string; at: number } | null>(null);

  const goToLogin = useCallback(() => {
    logout();
    navigate("/login", { replace: true });
  }, [navigate]);

  // Chargement initial : mon profil et mes conversations.
  useEffect(() => {
    Promise.all([getMe(), listConversations()])
      .then(([user, list]) => {
        setMe(user);
        setConversations(list);
      })
      .catch(goToLogin);
  }, [goToLogin]);

  // Marque la conversation comme lue (côté serveur → ✓✓ bleu chez l'expéditeur, et côté liste).
  const markRead = useCallback((conversationId: string) => {
    socketRef.current?.emit("message:read", { conversationId });
    setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
  }, []);

  const loadThread = useCallback(async (conversationId: string) => {
    const page = await listMessages(conversationId);
    setThreads((t) => ({ ...t, [conversationId]: { items: page.messages, nextCursor: page.nextCursor } }));
  }, []);

  // Nouveau nom / nouveaux membres d'un groupe (événement group:updated ou réponse de l'API).
  const applyGroupState = useCallback((conversationId: string, { name, members, photoId }: GroupState) => {
    setConversations((list) =>
      list.map((c) =>
        c.id === conversationId ? { ...c, name, members, ...(photoId !== undefined ? { photoId } : {}) } : c,
      ),
    );
  }, []);

  // J'ai quitté le groupe, ou on m'en a retiré : il disparaît de ma liste.
  const removeConversation = useCallback((conversationId: string) => {
    setConversations((list) => list.filter((c) => c.id !== conversationId));
    setThreads(({ [conversationId]: _removed, ...rest }) => rest);
    setTyping(({ [conversationId]: _removed, ...rest }) => rest);
    if (activeRef.current === conversationId) {
      setActiveId(null);
      setPanel(null);
    }
  }, []);

  // Connexion temps réel, une fois le profil connu.
  const meId = me?.id;
  useEffect(() => {
    if (!meId) return;
    const socket = createSocket(goToLogin);
    socketRef.current = socket;
    setSocket(socket);
    let firstConnection = true;

    socket.on("connect", () => {
      setConnected(true);
      // On repart d'un état vierge : la présence est redemandée (effet plus bas),
      // et un typing:update « false » a pu être manqué pendant la coupure.
      setPresence({});
      setTyping({});
      if (firstConnection) {
        firstConnection = false;
        return;
      }
      // Reconnexion après une coupure : on resynchronise ce qui a pu être manqué.
      listConversations().then(setConversations).catch(() => {});
      setThreads({});
      if (activeRef.current) loadThread(activeRef.current).catch(() => {});
    });
    socket.on("disconnect", () => setConnected(false));

    // Nouveau message (reçu, ou envoyé depuis un autre de mes appareils).
    socket.on("message:new", (message: Message) => {
      const mine = message.senderId === meId;
      // Événement de groupe ou trace d'appel : pas d'accusé, ne compte pas comme non lu.
      const system = message.type === "SYSTEM" || message.type === "CALL";
      const isOpen = activeRef.current === message.conversationId && isVisible();

      setThreads((t) => {
        const thread = t[message.conversationId];
        if (!thread || thread.items.some((m) => m.id === message.id)) return t; // pas chargé ou déjà là
        return { ...t, [message.conversationId]: { ...thread, items: [...thread.items, message] } };
      });

      if (!conversationsRef.current.some((c) => c.id === message.conversationId)) {
        // Quelqu'un vient de démarrer une discussion avec moi : on recharge la liste.
        listConversations().then(setConversations).catch(() => {});
      } else {
        setConversations((list) => {
          const conv = list.find((c) => c.id === message.conversationId)!;
          const updated: Conversation = {
            ...conv,
            lastMessage: message,
            updatedAt: message.createdAt,
            unreadCount: !mine && !system && !isOpen ? conv.unreadCount + 1 : conv.unreadCount,
          };
          return [updated, ...list.filter((c) => c.id !== conv.id)]; // remonte en haut de la liste
        });
      }

      if (!mine && !system) {
        socket.emit("message:delivered", { messageIds: [message.id] }); // ✓✓
        if (isOpen) socket.emit("message:read", { conversationId: message.conversationId }); // ✓✓ bleu
      }
    });

    // Mes messages ont été reçus / lus par un destinataire.
    socket.on("message:status", ({ conversationId, messageIds, status, aggregates }: StatusEvent) => {
      // On affiche le statut GLOBAL : en groupe, Bob qui lit ne rend pas le message bleu
      // tant que Carole ne l'a pas lu. (Repli sur `status` pour un ancien serveur.)
      const next = new Map(aggregates?.map((a) => [a.id, a.status]) ?? messageIds.map((id) => [id, status]));
      const bump = <M extends Message>(m: M): M => {
        const s = next.get(m.id);
        return s && RANK[s] > RANK[m.status] ? { ...m, status: s } : m;
      };
      setStatusTick((n) => n + 1);

      setThreads((t) => {
        const thread = t[conversationId];
        return thread ? { ...t, [conversationId]: { ...thread, items: thread.items.map(bump) } } : t;
      });
      setConversations((list) =>
        list.map((c) => (c.id === conversationId && c.lastMessage ? { ...c, lastMessage: bump(c.lastMessage) } : c)),
      );
    });

    // Un contact se connecte ou se déconnecte.
    socket.on("presence:update", ({ userId, online, lastSeenAt }: PresenceEvent) => {
      setPresence((p) => ({
        ...p,
        [userId]: { online, lastSeenAt: lastSeenAt ?? p[userId]?.lastSeenAt ?? null },
      }));
    });

    // Quelqu'un commence / arrête d'écrire dans une de mes conversations.
    socket.on("typing:update", ({ conversationId, userId, isTyping }: TypingEvent) => {
      setTyping((t) => {
        const users = new Set(t[conversationId] ?? []);
        if (isTyping) users.add(userId);
        else users.delete(userId);
        return { ...t, [conversationId]: [...users] };
      });
    });

    // Un groupe a changé (nom, membres, rôles).
    socket.on("group:updated", ({ conversationId, ...state }: GroupState & { conversationId: string }) => {
      if (conversationsRef.current.some((c) => c.id === conversationId)) applyGroupState(conversationId, state);
      else listConversations().then(setConversations).catch(() => {}); // on vient d'y être ajouté
    });

    // On m'a retiré d'un groupe (ou je l'ai quitté depuis un autre onglet).
    socket.on("group:removed", ({ conversationId }: { conversationId: string }) => removeConversation(conversationId));

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [meId, goToLogin, loadThread, applyGroupState, removeConversation]);

  // Demande la présence des contacts dont on ne connaît pas encore l'état
  // (au démarrage, après une reconnexion, quand une nouvelle conversation apparaît).
  useEffect(() => {
    const socket = socketRef.current;
    if (!connected || !socket) return;
    const missing = [
      ...new Set(
        conversations.map((c) => c.otherUser?.id).filter((id): id is string => !!id && !(id in presenceRef.current)),
      ),
    ];
    if (missing.length === 0) return;
    socket.emit(
      "presence:get",
      { userIds: missing },
      (res: { ok: boolean; presence?: PresenceEvent[] }) => {
        if (!res.ok || !res.presence) return;
        setPresence((p) => {
          const next = { ...p };
          for (const { userId, online, lastSeenAt } of res.presence!) next[userId] = { online, lastSeenAt };
          return next;
        });
      },
    );
  }, [connected, conversations]);

  // ---------- Saisie ----------

  const stopTyping = useCallback(() => {
    const last = lastTypingEmit.current;
    if (!last) return;
    socketRef.current?.emit("typing:stop", { conversationId: last.conversationId });
    lastTypingEmit.current = null;
  }, []);

  // Appelé à chaque modification du champ de saisie.
  const onDraftChange = useCallback(
    (draft: string) => {
      const socket = socketRef.current;
      const conversationId = activeRef.current;
      if (!socket || !conversationId) return;
      if (!draft.trim()) return stopTyping(); // champ vidé : on n'écrit plus

      const last = lastTypingEmit.current;
      const now = Date.now();
      if (last && last.conversationId === conversationId && now - last.at < TYPING_THROTTLE_MS) return;
      lastTypingEmit.current = { conversationId, at: now };
      socket.emit("typing:start", { conversationId });
    },
    [stopTyping],
  );

  // Retour sur l'onglet avec une conversation ouverte : elle devient lue.
  useEffect(() => {
    const onVisibility = () => {
      if (isVisible() && activeRef.current) markRead(activeRef.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [markRead]);

  const openConversation = async (id: string) => {
    if (id !== activeId) {
      stopTyping(); // on quitte la conversation où l'on écrivait
      setPanel(null);
    }
    setActiveId(id);
    setShowNewChat(false);
    setShowNewGroup(false);
    markRead(id);
    if (!threads[id]) await loadThread(id).catch(() => {});
  };

  const onConversationStarted = (conversation: Conversation) => {
    setConversations((list) => (list.some((c) => c.id === conversation.id) ? list : [conversation, ...list]));
    openConversation(conversation.id);
  };

  const loadOlder = async () => {
    if (!activeId) return;
    const cursor = threads[activeId]?.nextCursor;
    if (!cursor) return;
    const page = await listMessages(activeId, cursor);
    setThreads((t) => {
      const thread = t[activeId];
      const known = new Set(thread.items.map((m) => m.id));
      return {
        ...t,
        [activeId]: {
          items: [...page.messages.filter((m) => !known.has(m.id)), ...thread.items],
          nextCursor: page.nextCursor,
        },
      };
    });
  };

  // Envoi optimiste : le message s'affiche tout de suite (🕓), puis est remplacé
  // par la version enregistrée quand le serveur confirme (ack).
  const startOptimistic = (conversationId: string, build: (clientId: string) => Partial<ChatMessage>) => {
    const clientId = crypto.randomUUID();
    const optimistic: ChatMessage = {
      id: clientId,
      conversationId,
      senderId: me!.id,
      senderName: me!.name,
      type: "TEXT",
      content: null,
      media: null,
      createdAt: new Date().toISOString(),
      status: "SENT",
      pending: true,
      ...build(clientId),
    };

    const replace = (update: (m: ChatMessage) => ChatMessage) => {
      setThreads((t) => {
        const thread = t[conversationId];
        if (!thread) return t;
        return { ...t, [conversationId]: { ...thread, items: thread.items.map((m) => (m.id === clientId ? update(m) : m)) } };
      });
      setConversations((list) =>
        list.map((c) =>
          c.id === conversationId && c.lastMessage?.id === clientId ? { ...c, lastMessage: update(c.lastMessage) } : c,
        ),
      );
    };

    setThreads((t) => {
      const thread = t[conversationId] ?? { items: [], nextCursor: null };
      return { ...t, [conversationId]: { ...thread, items: [...thread.items, optimistic] } };
    });
    setConversations((list) => {
      const conv = list.find((c) => c.id === conversationId);
      if (!conv) return list;
      return [{ ...conv, lastMessage: optimistic, updatedAt: optimistic.createdAt }, ...list.filter((c) => c !== conv)];
    });

    const fail = (errorText?: string) => replace((m) => ({ ...m, pending: false, failed: true, errorText }));

    // Envoi du message par Socket.io (texte, ou référence vers un média déjà stocké).
    const emitSend = (payload: { content?: string; mediaId?: string }) => {
      const socket = socketRef.current;
      if (!socket) return fail();
      socket
        .timeout(10_000)
        .emit(
          "message:send",
          { conversationId, clientId, ...payload },
          (err: Error | null, res?: { ok: boolean; message?: Message; error?: string }) => {
            if (err || !res?.ok || !res.message) return fail(res?.error);
            const saved = res.message;
            replace((m) => ({ ...saved, localUrl: m.localUrl })); // garde l'aperçu local : pas de clignotement
          },
        );
    };

    return { replace, fail, emitSend };
  };

  const send = (content: string) => {
    if (!activeId || !me) return;
    lastTypingEmit.current = null; // le serveur arrête lui-même « en train d'écrire » à l'envoi
    startOptimistic(activeId, () => ({ content })).emitSend({ content });
  };

  // Photo, vidéo, document ou message vocal :
  // 1. envoi direct du fichier à MinIO (avec progression), 2. message:send avec l'id du média.
  const sendFile = async (file: File) => {
    if (!activeId || !me) return;
    const mimeType = mimeOf(file);
    const kind = kindOf(mimeType);
    const { replace, fail, emitSend } = startOptimistic(activeId, (clientId) => ({
      type: kind,
      // Id provisoire = celui du message : tant qu'ils sont égaux, le fichier est « en cours d'envoi ».
      media: { id: clientId, mimeType, size: file.size, fileName: file.name },
      localUrl: kind === "DOCUMENT" ? undefined : URL.createObjectURL(file),
      progress: 0,
    }));
    try {
      const media = await uploadFile(file, (progress) => replace((m) => ({ ...m, progress })));
      replace((m) => ({ ...m, media, progress: 1 }));
      emitSend({ mediaId: media.id });
    } catch (err) {
      fail(err instanceof Error ? err.message : undefined);
    }
  };

  // Ma photo de profil : même mécanisme (envoi direct à MinIO), puis PATCH /api/users/me/avatar.
  const avatarInput = useRef<HTMLInputElement>(null);
  const changeMyPhoto = async (file: File) => {
    try {
      const media = await uploadFile(file);
      setMe(await setMyAvatar(media.id));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Impossible de changer la photo");
    }
  };

  if (!me) return <div className="app-loading">Chargement…</div>;

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const thread = activeId ? threads[activeId] : undefined;
  // Qui écrit, conversation par conversation. En groupe, on nomme les personnes.
  const typingLabels: Record<string, string> = {};
  for (const c of conversations) {
    const userIds = typing[c.id] ?? [];
    if (userIds.length === 0) continue;
    if (c.type !== "GROUP") {
      typingLabels[c.id] = "en train d'écrire…";
      continue;
    }
    const names = userIds.map((id) => c.members?.find((m) => m.user.id === id)?.user.name ?? "Quelqu'un");
    typingLabels[c.id] = groupTypingLabel(names);
  }

  // Sous-titre de l'en-tête, par ordre de priorité, comme WhatsApp.
  const headerStatus = (c: Conversation): { text: string; highlight?: boolean } | null => {
    if (typingLabels[c.id]) return { text: typingLabels[c.id], highlight: true };
    if (c.type === "GROUP") {
      // « Alice, Bob, Vous »
      const others = (c.members ?? []).filter((m) => m.user.id !== me.id).map((m) => m.user.name);
      return { text: [...others, "Vous"].join(", ") };
    }
    if (!c.otherUser) return null;
    const p = presence[c.otherUser.id];
    if (p?.online) return { text: "en ligne" };
    if (p?.lastSeenAt) return { text: formatLastSeen(p.lastSeenAt) };
    return { text: c.otherUser.phone };
  };

  return (
    <div className={`app${active ? " app--chat-open" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar__header">
          {/* Cliquer sur mon avatar : changer ma photo de profil. */}
          <button
            type="button"
            className="avatar-button"
            onClick={() => avatarInput.current?.click()}
            title="Changer ma photo de profil"
            aria-label="Changer ma photo de profil"
          >
            <Avatar name={me.name} mediaId={me.avatarId} size={40} />
          </button>
          <input
            ref={avatarInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) changeMyPhoto(file);
            }}
          />
          <span className="sidebar__me">{me.name}</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setShowNewChat((v) => !v);
              setShowNewGroup(false);
            }}
          >
            Nouvelle discussion
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setShowNewGroup((v) => !v);
              setShowNewChat(false);
            }}
          >
            Nouveau groupe
          </button>
          <button type="button" className="btn" onClick={goToLogin}>
            Déconnexion
          </button>
        </header>
        {!connected && <div className="sidebar__offline">Connexion au serveur…</div>}
        {showNewChat && <NewChat onStarted={onConversationStarted} onCancel={() => setShowNewChat(false)} />}
        {showNewGroup && <NewGroup onCreated={onConversationStarted} onCancel={() => setShowNewGroup(false)} />}
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          meId={me.id}
          typingLabels={typingLabels}
          onOpen={openConversation}
        />
      </aside>

      <main className={`chat-pane${active && panel ? " chat-pane--with-panel" : ""}`}>
        {active ? (
          <ChatWindow
            conversation={active}
            messages={thread?.items ?? []}
            hasMore={Boolean(thread?.nextCursor)}
            meId={me.id}
            status={headerStatus(active)}
            onSend={send}
            onSendFile={sendFile}
            onDraftChange={onDraftChange}
            onLoadOlder={loadOlder}
            onBack={() => {
              stopTyping();
              setActiveId(null);
              setPanel(null);
            }}
            onOpenGroupInfo={() => setPanel({ kind: "group" })}
            onOpenMessageInfo={(messageId) => setPanel({ kind: "message", messageId })}
            callInProgress={!!call.state}
            onStartCall={(type) => {
              if (active.otherUser) {
                const { id, name, avatarId } = active.otherUser;
                call.startCall(active.id, { id, name, avatarId }, type);
              }
            }}
          />
        ) : (
          <div className="chat-empty">
            <h2>WhatsApp Clone</h2>
            <p>Sélectionnez une discussion ou démarrez-en une nouvelle avec un numéro de téléphone.</p>
          </div>
        )}
        {active && panel?.kind === "group" && active.type === "GROUP" && (
          <GroupInfo
            conversation={active}
            meId={me.id}
            onUpdated={applyGroupState}
            onLeft={removeConversation}
            onClose={() => setPanel(null)}
          />
        )}
        {active && panel?.kind === "message" && (
          <MessageInfo
            conversationId={active.id}
            messageId={panel.messageId}
            refreshKey={statusTick}
            onClose={() => setPanel(null)}
          />
        )}
      </main>

      {/* Appels : sonnerie entrante, puis écran d'appel (au-dessus de tout). */}
      {call.state?.phase === "incoming" && (
        <IncomingCall call={call.state} onAccept={call.accept} onReject={call.reject} />
      )}
      {call.state && call.state.phase !== "incoming" && (
        <CallScreen
          call={call.state}
          localStream={call.localStream}
          remoteStream={call.remoteStream}
          onHangUp={call.hangUp}
          onToggleMic={call.toggleMic}
          onToggleCamera={call.toggleCamera}
        />
      )}
    </div>
  );
}
