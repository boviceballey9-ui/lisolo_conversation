import { Fragment, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Conversation, Message } from "../api";
import { formatDayLabel, formatTime } from "../format";
import { Avatar } from "./Avatar";
import { conversationTitle } from "./ConversationList";
import { Ticks } from "./Ticks";

// Message affiché : peut être « en attente » (envoi optimiste, pas encore confirmé)
// ou en échec.
export type ChatMessage = Message & { pending?: boolean; failed?: boolean };

interface Props {
  conversation: Conversation;
  messages: ChatMessage[];
  hasMore: boolean;
  meId: string;
  onSend: (content: string) => void;
  onLoadOlder: () => Promise<void>;
  onBack: () => void;
}

export function ChatWindow({ conversation, messages, hasMore, meId, onSend, onLoadOlder, onBack }: Props) {
  const [draft, setDraft] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previous = useRef({ firstId: "", lastId: "", scrollHeight: 0 });

  // Gestion du défilement après chaque changement de la liste :
  // - messages plus anciens ajoutés en haut → on garde la même position visuelle ;
  // - nouveau message en bas → on descend (si c'est le mien ou si on était déjà en bas).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = messages[0]?.id ?? "";
    const last = messages[messages.length - 1];
    const prev = previous.current;

    if (prev.firstId && firstId !== prev.firstId && last?.id === prev.lastId) {
      el.scrollTop += el.scrollHeight - prev.scrollHeight; // pagination
    } else if (last && last.id !== prev.lastId) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (!prev.lastId || last.senderId === meId || nearBottom) el.scrollTop = el.scrollHeight;
    }
    previous.current = { firstId, lastId: last?.id ?? "", scrollHeight: el.scrollHeight };
  }, [messages, meId]);

  // Nouvelle conversation ouverte : on repart de zéro (défilement en bas).
  useLayoutEffect(() => {
    previous.current = { firstId: "", lastId: "", scrollHeight: 0 };
    setDraft("");
  }, [conversation.id]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft("");
  };

  // Entrée envoie, Maj+Entrée fait un retour à la ligne.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  const title = conversationTitle(conversation);

  return (
    <section className="chat">
      <header className="chat__header">
        <button type="button" className="chat__back" onClick={onBack} aria-label="Retour aux discussions">
          ←
        </button>
        <Avatar name={title} size={40} />
        <div>
          <div className="chat__title">{title}</div>
          {conversation.otherUser && <div className="chat__subtitle">{conversation.otherUser.phone}</div>}
        </div>
      </header>

      <div className="chat__messages" ref={scrollRef}>
        {hasMore && (
          <button type="button" className="chat__older" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? "Chargement…" : "Afficher les messages précédents"}
          </button>
        )}
        {messages.map((m, i) => {
          const mine = m.senderId === meId;
          const day = formatDayLabel(m.createdAt);
          const showDay = i === 0 || formatDayLabel(messages[i - 1].createdAt) !== day;
          return (
            <Fragment key={m.id}>
              {showDay && <div className="chat__day">{day}</div>}
              <div className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"}`}>
                <span className="bubble__text">{m.content}</span>
                <span className="bubble__meta">
                  {formatTime(m.createdAt)}
                  {mine && !m.failed && <Ticks status={m.status} pending={m.pending} />}
                  {m.failed && <span className="bubble__failed">Non envoyé</span>}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>

      <form className="chat__composer" onSubmit={send}>
        <textarea
          rows={1}
          placeholder="Tapez un message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={4096}
          aria-label="Message"
        />
        <button type="submit" className="chat__send" disabled={!draft.trim()} aria-label="Envoyer">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M2 21 23 12 2 3v7l15 2-15 2z" />
          </svg>
        </button>
      </form>
    </section>
  );
}
