// Heure d'un message : "14:05".
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Date dans la liste des conversations : l'heure si c'est aujourd'hui, "Hier", sinon la date.
export function formatListDate(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return formatTime(iso);
  if (date.toDateString() === yesterday.toDateString()) return "Hier";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

// Séparateur de jour dans la fenêtre de chat : "Aujourd'hui", "Hier", "lundi 23 novembre".
export function formatDayLabel(iso: string) {
  const label = formatListDate(iso);
  if (label === "Hier") return label;
  if (label.includes(":")) return "Aujourd'hui";
  return new Date(iso).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

// En-tête de conversation : "vu(e) aujourd'hui à 14:05", "vu(e) hier à 09:12", "vu(e) le 23/11/26 à 18:40".
export function formatLastSeen(iso: string) {
  const label = formatListDate(iso);
  const time = formatTime(iso);
  if (label === "Hier") return `vu(e) hier à ${time}`;
  if (label === time) return `vu(e) aujourd'hui à ${time}`;
  return `vu(e) le ${label} à ${time}`;
}

// Taille de fichier : "850 o", "12 Ko", "3,4 Mo".
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

// Durée d'un enregistrement : "0:07", "1:23".
export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Aperçu d'un message dans la liste des conversations.
export function messagePreview(m: { type: string; content: string | null; media: { fileName: string | null } | null }) {
  const label = {
    IMAGE: "📷 Photo",
    VIDEO: "🎥 Vidéo",
    AUDIO: "🎤 Message vocal",
    DOCUMENT: `📄 ${m.media?.fileName ?? "Document"}`,
  }[m.type];
  if (!label) return m.content ?? "";
  return m.content ? `${label} · ${m.content}` : label;
}

// Initiales pour l'avatar : "Alice Martin" → "AM".
export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
