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
  // Sous-titre de l'en-tête : « en train d'écrire… », « en ligne », « vu(e) … ».
  status: { text: string; highlight?: boolean } | null;
  onSend: (content: string) => void;
  onDraftChange: (draft: string) => void;
  onLoadOlder: () => Promise<void>;
  onBack: () => void;
  onOpenGroupInfo: () => void;
  onOpenMessageInfo: (messageId: string) => void;
}

export function ChatWindow({
  conversation,
  messages,
  hasMore,
  meId,
  status,
  onSend,
  onDraftChange,
  onLoadOlder,
  onBack,
  onOpenGroupInfo,
  onOpenMessageInfo,
}: Props) {
  const isGroup = conversation.type === "GROUP";
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
        {/* En groupe, cliquer sur l'en-tête ouvre « Infos du groupe », comme WhatsApp. */}
        <button
          type="button"
          className="chat__identity"
          onClick={isGroup ? onOpenGroupInfo : undefined}
          disabled={!isGroup}
          aria-label={isGroup ? "Infos du groupe" : undefined}
        >
          <Avatar name={title} size={40} />
          <div className="chat__identity-text">
            <div className="chat__title">{title}</div>
            {status && (
              <div className={`chat__subtitle${status.highlight ? " chat__subtitle--active" : ""}`} aria-live="polite">
                {status.text}
              </div>
            )}
          </div>
        </button>
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
          const previous = messages[i - 1];
          const showDay = i === 0 || formatDayLabel(previous.createdAt) !== day;

          // Événement de groupe : pastille centrée, sans bulle ni coches.
          if (m.type === "SYSTEM") {
            return (
              <Fragment key={m.id}>
                {showDay && <div className="chat__day">{day}</div>}
                <div className="chat__system">{m.content}</div>
              </Fragment>
            );
          }

          // En groupe, le nom de l'auteur au-dessus de sa bulle (une fois par série de messages).
          const showSender =
            isGroup && !mine && (showDay || previous.senderId !== m.senderId || previous.type === "SYSTEM");
          const canInspect = mine && !m.pending && !m.failed;
          return (
            <Fragment key={m.id}>
              {showDay && <div className="chat__day">{day}</div>}
              <div className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"}`}>
                {showSender && <span className="bubble__sender">{m.senderName}</span>}
                <span className="bubble__text">{m.content}</span>
                <span className="bubble__meta">
                  {canInspect && (
                    <button
                      type="button"
                      className="bubble__info"
                      onClick={() => onOpenMessageInfo(m.id)}
                      aria-label="Infos du message"
                      title="Infos du message"
                    >
                      Infos
                    </button>
                  )}
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
          onChange={(e) => {
            setDraft(e.target.value);
            onDraftChange(e.target.value);
          }}
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
