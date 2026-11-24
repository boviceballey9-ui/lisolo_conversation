import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Socket } from "socket.io-client";
import {
  getMe,
  listConversations,
  listMessages,
  logout,
  type Conversation,
  type DeliveryStatus,
  type Message,
  type User,
} from "../api";
import { Avatar } from "../components/Avatar";
import { ChatWindow, type ChatMessage } from "../components/ChatWindow";
import { ConversationList } from "../components/ConversationList";
import { NewChat } from "../components/NewChat";
import { formatLastSeen } from "../format";
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
  status: DeliveryStatus;
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
  const [connected, setConnected] = useState(false);
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

  // Connexion temps réel, une fois le profil connu.
  const meId = me?.id;
  useEffect(() => {
    if (!meId) return;
    const socket = createSocket(goToLogin);
    socketRef.current = socket;
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
            unreadCount: !mine && !isOpen ? conv.unreadCount + 1 : conv.unreadCount,
          };
          return [updated, ...list.filter((c) => c.id !== conv.id)]; // remonte en haut de la liste
        });
      }

      if (!mine) {
        socket.emit("message:delivered", { messageIds: [message.id] }); // ✓✓
        if (isOpen) socket.emit("message:read", { conversationId: message.conversationId }); // ✓✓ bleu
      }
    });

    // Mes messages ont été reçus / lus par le destinataire.
    socket.on("message:status", ({ conversationId, messageIds, status }: StatusEvent) => {
      const ids = new Set(messageIds);
      const bump = <M extends Message>(m: M): M =>
        ids.has(m.id) && RANK[status] > RANK[m.status] ? { ...m, status } : m;

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

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [meId, goToLogin, loadThread]);

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
    if (id !== activeId) stopTyping(); // on quitte la conversation où l'on écrivait
    setActiveId(id);
    setShowNewChat(false);
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
  const send = (content: string) => {
    const socket = socketRef.current;
    if (!activeId || !me || !socket) return;
    const conversationId = activeId;
    const clientId = crypto.randomUUID();
    lastTypingEmit.current = null; // le serveur arrête lui-même « en train d'écrire » à l'envoi
    const optimistic: ChatMessage = {
      id: clientId,
      conversationId,
      senderId: me.id,
      type: "TEXT",
      content,
      createdAt: new Date().toISOString(),
      status: "SENT",
      pending: true,
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

    socket
      .timeout(10_000)
      .emit(
        "message:send",
        { conversationId, content, clientId },
        (err: Error | null, res?: { ok: boolean; message?: Message }) => {
          if (err || !res?.ok || !res.message) {
            replace((m) => ({ ...m, pending: false, failed: true }));
          } else {
            const saved = res.message;
            replace(() => saved);
          }
        },
      );
  };

  if (!me) return <div className="app-loading">Chargement…</div>;

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const thread = activeId ? threads[activeId] : undefined;
  const typingConversations = new Set(Object.keys(typing).filter((id) => typing[id].length > 0));

  // Sous-titre de l'en-tête, par ordre de priorité, comme WhatsApp.
  const headerStatus = (c: Conversation): { text: string; highlight?: boolean } | null => {
    if (typingConversations.has(c.id)) return { text: "en train d'écrire…", highlight: true };
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
          <Avatar name={me.name} size={40} />
          <span className="sidebar__me">{me.name}</span>
          <button type="button" className="btn" onClick={() => setShowNewChat((v) => !v)}>
            Nouvelle discussion
          </button>
          <button type="button" className="btn" onClick={goToLogin}>
            Déconnexion
          </button>
        </header>
        {!connected && <div className="sidebar__offline">Connexion au serveur…</div>}
        {showNewChat && <NewChat onStarted={onConversationStarted} onCancel={() => setShowNewChat(false)} />}
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          meId={me.id}
          typingConversations={typingConversations}
          onOpen={openConversation}
        />
      </aside>

      <main className="chat-pane">
        {active ? (
          <ChatWindow
            conversation={active}
            messages={thread?.items ?? []}
            hasMore={Boolean(thread?.nextCursor)}
            meId={me.id}
            status={headerStatus(active)}
            onSend={send}
            onDraftChange={onDraftChange}
            onLoadOlder={loadOlder}
            onBack={() => {
              stopTyping();
              setActiveId(null);
            }}
          />
        ) : (
          <div className="chat-empty">
            <h2>WhatsApp Clone</h2>
            <p>Sélectionnez une discussion ou démarrez-en une nouvelle avec un numéro de téléphone.</p>
          </div>
        )}
      </main>
    </div>
  );
}
