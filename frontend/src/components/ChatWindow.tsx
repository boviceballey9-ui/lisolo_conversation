import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Conversation, Message } from "../api";
import { formatDayLabel, formatTime } from "../format";
import { Avatar } from "./Avatar";
import { conversationTitle } from "./ConversationList";
import { MediaContent } from "./MediaContent";
import { Ticks } from "./Ticks";
import { VoiceRecorder } from "./VoiceRecorder";

// Message affiché : peut être « en attente » (envoi optimiste, pas encore confirmé)
// ou en échec.
export type ChatMessage = Message & {
  pending?: boolean;
  failed?: boolean;
  errorText?: string; // raison de l'échec (ex. « Fichier trop volumineux… »)
  localUrl?: string; // aperçu local d'un fichier en cours d'envoi
  progress?: number; // progression de l'envoi vers MinIO (0 → 1)
};

// Types acceptés par le sélecteur « Document » (le serveur revérifie).
const DOCUMENT_ACCEPT = ".pdf,.txt,.csv,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp";

interface Props {
  conversation: Conversation;
  messages: ChatMessage[];
  hasMore: boolean;
  meId: string;
  // Sous-titre de l'en-tête : « en train d'écrire… », « en ligne », « vu(e) … ».
  status: { text: string; highlight?: boolean } | null;
  onSend: (content: string) => void;
  onSendFile: (file: File) => void;
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
  onSendFile,
  onDraftChange,
  onLoadOlder,
  onBack,
  onOpenGroupInfo,
  onOpenMessageInfo,
}: Props) {
  const isGroup = conversation.type === "GROUP";
  const [draft, setDraft] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); // erreur micro, etc.
  const mediaInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);

  // Fichiers choisis dans le sélecteur : chacun devient un message.
  const onFilesPicked = (input: HTMLInputElement) => {
    for (const file of Array.from(input.files ?? [])) onSendFile(file);
    input.value = ""; // permet de rechoisir le même fichier
    setAttachOpen(false);
  };

  // Les messages d'information disparaissent seuls.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
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
          <Avatar name={title} mediaId={conversation.otherUser?.avatarId ?? conversation.photoId} size={40} />
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
                {m.media && (
                  <MediaContent
                    type={m.type}
                    media={m.media}
                    localUrl={m.localUrl}
                    progress={m.progress}
                    uploading={m.pending && m.media.id === m.id}
                  />
                )}
                {m.content && <span className="bubble__text">{m.content}</span>}
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
                  {m.failed && (
                    <span className="bubble__failed" title={m.errorText}>
                      {m.errorText ?? "Non envoyé"}
                    </span>
                  )}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>

      {notice && (
        <div className="chat__notice" role="alert">
          {notice}
        </div>
      )}
      <form className="chat__composer" onSubmit={send}>
        {/* Trombone : photo / vidéo, ou document. */}
        <div className="attach">
          <button
            type="button"
            className="chat__icon-btn"
            onClick={() => setAttachOpen((v) => !v)}
            aria-label="Joindre un fichier"
            aria-expanded={attachOpen}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5H9v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10h-1.5z"
              />
            </svg>
          </button>
          {attachOpen && (
            <div className="attach__menu" role="menu">
              <button type="button" role="menuitem" onClick={() => mediaInput.current?.click()}>
                🖼️ Photo ou vidéo
              </button>
              <button type="button" role="menuitem" onClick={() => documentInput.current?.click()}>
                📄 Document
              </button>
            </div>
          )}
          <input
            ref={mediaInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
            multiple
            hidden
            onChange={(e) => onFilesPicked(e.currentTarget)}
          />
          <input
            ref={documentInput}
            type="file"
            accept={DOCUMENT_ACCEPT}
            multiple
            hidden
            onChange={(e) => onFilesPicked(e.currentTarget)}
          />
        </div>
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
        {/* Comme WhatsApp : bouton « envoyer » quand on a écrit, micro sinon. */}
        {draft.trim() ? (
          <button type="submit" className="chat__send" aria-label="Envoyer">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M2 21 23 12 2 3v7l15 2-15 2z" />
            </svg>
          </button>
        ) : (
          <VoiceRecorder onRecorded={onSendFile} onError={setNotice} />
        )}
      </form>
    </section>
  );
}
