import type { Conversation } from "../api";
import { formatListDate } from "../format";
import { Avatar } from "./Avatar";
import { Ticks } from "./Ticks";

export const conversationTitle = (c: Conversation) => c.otherUser?.name ?? c.name ?? "Discussion";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  meId: string;
  typingConversations: Set<string>; // conversations où quelqu'un est en train d'écrire
  onOpen: (id: string) => void;
}

export function ConversationList({ conversations, activeId, meId, typingConversations, onOpen }: Props) {
  if (conversations.length === 0) {
    return (
      <p className="sidebar__empty">
        Aucune discussion pour l'instant.
        <br />
        Cliquez sur « Nouvelle discussion » pour commencer.
      </p>
    );
  }

  return (
    <ul className="conv-list">
      {conversations.map((c) => {
        const last = c.lastMessage;
        const mine = last?.senderId === meId;
        return (
          <li key={c.id}>
            <button
              type="button"
              className={`conv-item${c.id === activeId ? " conv-item--active" : ""}`}
              onClick={() => onOpen(c.id)}
            >
              <Avatar name={conversationTitle(c)} size={48} />
              <div className="conv-item__body">
                <div className="conv-item__row">
                  <span className="conv-item__name">{conversationTitle(c)}</span>
                  <span className={`conv-item__date${c.unreadCount ? " conv-item__date--unread" : ""}`}>
                    {formatListDate(last?.createdAt ?? c.updatedAt)}
                  </span>
                </div>
                <div className="conv-item__row">
                  {typingConversations.has(c.id) ? (
                    <span className="conv-item__preview conv-item__preview--typing">en train d'écrire…</span>
                  ) : (
                    <span className="conv-item__preview">
                      {mine && <Ticks status={last.status} />}
                      {last?.content ?? <em>Aucun message</em>}
                    </span>
                  )}
                  {c.unreadCount > 0 && (
                    <span className="badge" aria-label={`${c.unreadCount} non lus`}>
                      {c.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
