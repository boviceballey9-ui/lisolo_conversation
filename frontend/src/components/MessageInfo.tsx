import { useEffect, useState } from "react";
import { getMessageInfo, type MessageInfo as Info } from "../api";
import { formatListDate, formatTime } from "../format";
import { Avatar } from "./Avatar";
import { MediaContent } from "./MediaContent";

interface Props {
  conversationId: string;
  messageId: string;
  refreshKey: number; // change à chaque accusé reçu : on recharge la liste
  onClose: () => void;
}

const when = (iso: string) => {
  const day = formatListDate(iso);
  const time = formatTime(iso);
  return day === time ? `aujourd'hui à ${time}` : `${day === "Hier" ? "hier" : `le ${day}`} à ${time}`;
};

// Écran « Infos du message » : qui l'a lu, à qui il a été distribué, qui ne l'a pas encore reçu.
export function MessageInfo({ conversationId, messageId, refreshKey, onClose }: Props) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMessageInfo(conversationId, messageId)
      .then((data) => !cancelled && setInfo(data))
      .catch(() => !cancelled && setError("Impossible de charger les informations"));
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageId, refreshKey]);

  const read = info?.recipients.filter((r) => r.status === "READ") ?? [];
  const delivered = info?.recipients.filter((r) => r.status === "DELIVERED") ?? [];
  const pending = info?.recipients.filter((r) => r.status === "SENT") ?? [];

  const section = (title: string, rows: Info["recipients"], date: (r: Info["recipients"][number]) => string | null) =>
    rows.length > 0 && (
      <section className="side-panel__section">
        <h3 className="info-title">{title}</h3>
        <ul className="member-list">
          {rows.map((r) => {
            const at = date(r);
            return (
              <li key={r.user.id} className="member">
                <Avatar name={r.user.name} mediaId={r.user.avatarId} size={36} />
                <div className="member__body">
                  <div className="member__name">{r.user.name}</div>
                  {at && <div className="member__phone">{when(at)}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );

  return (
    <aside className="side-panel" aria-label="Infos du message">
      <header className="side-panel__header">
        <button type="button" className="side-panel__close" onClick={onClose} aria-label="Fermer">
          ×
        </button>
        <span>Infos du message</span>
      </header>
      <div className="side-panel__body">
        {error && <p className="new-chat__error">{error}</p>}
        {!info && !error && <p className="sidebar__empty">Chargement…</p>}
        {info && (
          <>
            <div className="bubble bubble--mine info-preview">
              {info.message.media && <MediaContent type={info.message.type} media={info.message.media} />}
              {info.message.content && <span className="bubble__text">{info.message.content}</span>}
              <span className="bubble__meta">{formatTime(info.message.createdAt)}</span>
            </div>
            {section("Lu par", read, (r) => r.readAt)}
            {section("Distribué à", delivered, (r) => r.deliveredAt)}
            {section("En attente", pending, () => null)}
          </>
        )}
      </div>
    </aside>
  );
}
