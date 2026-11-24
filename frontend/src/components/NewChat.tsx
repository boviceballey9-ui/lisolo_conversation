import { useState, type FormEvent } from "react";
import { ApiError, startConversation, type Conversation } from "../api";

interface Props {
  onStarted: (conversation: Conversation) => void;
  onCancel: () => void;
}

// Démarrer une discussion à partir du numéro de téléphone d'un utilisateur.
export function NewChat({ onStarted, onCancel }: Props) {
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      onStarted(await startConversation(phone.replace(/\s/g, ""))); // tolère "+33 6 12 34 56 78"
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Impossible de joindre le serveur");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="new-chat" onSubmit={submit}>
      <label htmlFor="new-chat-phone">Numéro de téléphone du contact</label>
      <div className="new-chat__row">
        <input
          id="new-chat-phone"
          type="tel"
          placeholder="+33612345678"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoFocus
        />
        <button type="submit" className="btn btn--primary" disabled={loading || !phone.trim()}>
          {loading ? "…" : "Discuter"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Annuler
        </button>
      </div>
      {error && (
        <p className="new-chat__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
