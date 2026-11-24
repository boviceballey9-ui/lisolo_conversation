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

// Initiales pour l'avatar : "Alice Martin" → "AM".
export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
