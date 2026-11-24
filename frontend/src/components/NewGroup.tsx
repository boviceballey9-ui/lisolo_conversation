import { useState, type FormEvent } from "react";
import { ApiError, createGroup, type Conversation } from "../api";

interface Props {
  onCreated: (conversation: Conversation) => void;
  onCancel: () => void;
}

const normalize = (phone: string) => phone.replace(/\s/g, ""); // tolère "+33 6 12 34 56 78"

// Créer un groupe : un nom et au moins un membre (par numéro). Je deviens admin.
export function NewGroup({ onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phones, setPhones] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const addPhone = () => {
    const value = normalize(phone);
    if (!value) return;
    setPhones((list) => (list.includes(value) ? list : [...list, value]));
    setPhone("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Un numéro tapé mais pas encore « ajouté » est pris en compte aussi.
    const all = [...new Set([...phones, normalize(phone)].filter(Boolean))];
    setLoading(true);
    setError(null);
    try {
      onCreated(await createGroup(name.trim(), all));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Impossible de joindre le serveur");
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = name.trim() && (phones.length > 0 || normalize(phone));

  return (
    <form className="new-chat" onSubmit={submit}>
      <label htmlFor="new-group-name">Nom du groupe</label>
      <input
        id="new-group-name"
        className="new-chat__input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        placeholder="Ex. : Famille"
        autoFocus
      />

      <label htmlFor="new-group-phone">Membres (numéros de téléphone)</label>
      <div className="new-chat__row">
        <input
          id="new-group-phone"
          type="tel"
          placeholder="+33612345678"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // Entrée ajoute le numéro au lieu de créer le groupe
              addPhone();
            }
          }}
        />
        <button type="button" className="btn" onClick={addPhone} disabled={!phone.trim()}>
          Ajouter
        </button>
      </div>

      {phones.length > 0 && (
        <ul className="chips">
          {phones.map((p) => (
            <li key={p} className="chip">
              {p}
              <button
                type="button"
                aria-label={`Retirer ${p}`}
                onClick={() => setPhones((list) => list.filter((x) => x !== p))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="new-chat__row">
        <button type="submit" className="btn btn--primary" disabled={loading || !canSubmit}>
          {loading ? "…" : "Créer le groupe"}
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
