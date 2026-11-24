import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addGroupMembers,
  ApiError,
  leaveGroup,
  promoteGroupAdmin,
  removeGroupMember,
  renameGroup,
  setGroupPhoto,
  type Conversation,
  type GroupState,
} from "../api";
import { uploadFile } from "../media";
import { Avatar } from "./Avatar";

interface Props {
  conversation: Conversation; // un groupe
  meId: string;
  onUpdated: (conversationId: string, state: GroupState) => void;
  onLeft: (conversationId: string) => void;
  onClose: () => void;
}

// Écran « Infos du groupe » : membres, rôles, actions d'admin, quitter.
// Les actions d'admin ne sont AFFICHÉES qu'aux admins, mais le serveur revérifie tout :
// un membre qui appellerait l'API à la main recevrait un 403.
export function GroupInfo({ conversation, meId, onUpdated, onLeft, onClose }: Props) {
  const members = conversation.members ?? [];
  const isAdmin = members.some((m) => m.user.id === meId && m.role === "ADMIN");
  const [name, setName] = useState(conversation.name ?? "");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  // Renommé par un autre admin pendant que le panneau est ouvert : on suit.
  useEffect(() => setName(conversation.name ?? ""), [conversation.name]);

  // Exécute une action, affiche l'erreur éventuelle de l'API (ex. 403).
  const run = async (action: () => Promise<GroupState | void>) => {
    setBusy(true);
    setError(null);
    try {
      const state = await action();
      if (state) onUpdated(conversation.id, state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Impossible de joindre le serveur");
    } finally {
      setBusy(false);
    }
  };

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== conversation.name) run(() => renameGroup(conversation.id, name.trim()));
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const value = phone.replace(/\s/g, "");
    if (!value) return;
    run(async () => {
      const state = await addGroupMembers(conversation.id, [value]);
      setPhone("");
      return state;
    });
  };

  const leave = () => {
    if (!window.confirm(`Quitter le groupe « ${conversation.name} » ?`)) return;
    run(async () => {
      await leaveGroup(conversation.id);
      onLeft(conversation.id);
    });
  };

  return (
    <aside className="side-panel" aria-label="Infos du groupe">
      <header className="side-panel__header">
        <button type="button" className="side-panel__close" onClick={onClose} aria-label="Fermer">
          ×
        </button>
        <span>Infos du groupe</span>
      </header>

      <div className="side-panel__body">
        <div className="group-card">
          <Avatar name={conversation.name ?? "Groupe"} mediaId={conversation.photoId} size={96} />
          {isAdmin && (
            <div className="group-card__photo-actions">
              {/* Même mécanisme que les pièces jointes : envoi direct à MinIO, puis PATCH .../photo. */}
              <button type="button" className="btn" disabled={busy} onClick={() => photoInput.current?.click()}>
                {conversation.photoId ? "Changer la photo" : "Ajouter une photo"}
              </button>
              {conversation.photoId && (
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={() => run(() => setGroupPhoto(conversation.id, null))}
                >
                  Retirer
                </button>
              )}
              <input
                ref={photoInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file) run(async () => setGroupPhoto(conversation.id, (await uploadFile(file)).id));
                }}
              />
            </div>
          )}
          {isAdmin ? (
            <form className="group-card__rename" onSubmit={rename}>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-label="Nom du groupe" />
              <button type="submit" className="btn" disabled={busy || !name.trim() || name.trim() === conversation.name}>
                Renommer
              </button>
            </form>
          ) : (
            <h2 className="group-card__name">{conversation.name}</h2>
          )}
          <p className="group-card__count">Groupe · {members.length} membres</p>
        </div>

        {error && (
          <p className="new-chat__error" role="alert">
            {error}
          </p>
        )}

        {isAdmin && (
          <form className="new-chat__row side-panel__section" onSubmit={add}>
            <input
              type="tel"
              placeholder="Ajouter : +33612345678"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-label="Numéro du membre à ajouter"
            />
            <button type="submit" className="btn btn--primary" disabled={busy || !phone.trim()}>
              Ajouter
            </button>
          </form>
        )}

        <ul className="member-list">
          {members.map((m) => {
            const isMe = m.user.id === meId;
            return (
              <li key={m.user.id} className="member">
                <Avatar name={m.user.name} mediaId={m.user.avatarId} size={40} />
                <div className="member__body">
                  <div className="member__name">{isMe ? "Vous" : m.user.name}</div>
                  <div className="member__phone">{m.user.phone}</div>
                </div>
                {m.role === "ADMIN" && <span className="member__badge">Admin</span>}
                {isAdmin && !isMe && (
                  <div className="member__actions">
                    {m.role !== "ADMIN" && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => run(() => promoteGroupAdmin(conversation.id, m.user.id))}
                      >
                        Nommer admin
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Retirer ${m.user.name} du groupe ?`)) {
                          run(() => removeGroupMember(conversation.id, m.user.id));
                        }
                      }}
                    >
                      Retirer
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <button type="button" className="btn btn--danger side-panel__leave" onClick={leave} disabled={busy}>
          Quitter le groupe
        </button>
      </div>
    </aside>
  );
}
