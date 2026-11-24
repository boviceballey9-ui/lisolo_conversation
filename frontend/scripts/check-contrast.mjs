// Vérifie le contraste WCAG 2.x de la charte Lisolo.
//   npm run check:contrast
//
// Lit les variables de :root dans src/chat.css (source unique des couleurs), puis contrôle
// chaque paire « couleur de premier plan / fond » réellement utilisée dans l'interface :
//   - texte : ratio ≥ 4,5:1 (niveau AA, texte normal) ;
//   - icônes et contours de champs : ratio ≥ 3:1 (AA, critère 1.4.11 « contraste non textuel »).
// Échoue (code de sortie 1) si une paire est insuffisante.

import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/chat.css", import.meta.url), "utf8");
const root = css.match(/:root\s*{([^}]*)}/)?.[1] ?? "";
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));

const color = (v) => {
  const hex = vars[v] ?? v;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Couleur inconnue ou non hexadécimale : ${v}`);
  return hex;
};
const channel = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT = 4.5;
const UI = 3;
// [description, premier plan, fond, seuil]
const pairs = [
  ["Texte des bulles envoyées", "bubble-mine-text", "bubble-mine", TEXT],
  ["Heure des bulles envoyées", "bubble-mine-meta", "bubble-mine", TEXT],
  ["Coches envoyé / reçu sur bulle envoyée", "tick-on-accent", "bubble-mine", UI],
  ["Coche « lu » sur bulle envoyée", "read", "bubble-mine", UI],
  ["« Non envoyé » sur bulle envoyée", "danger-on-accent", "bubble-mine", TEXT],
  ["Texte des bulles reçues", "ink", "bubble-theirs", TEXT],
  ["Heure des bulles reçues", "ink-muted", "bubble-theirs", TEXT],
  ["Nom de l'auteur (groupe) sur bulle reçue", "bordeaux-dark", "bubble-theirs", TEXT],
  ["Texte sur le fond du chat", "ink", "chat-bg", TEXT],
  ["Texte secondaire sur le fond du chat", "ink-muted", "chat-bg", TEXT],
  ["Texte principal sur blanc", "ink", "surface", TEXT],
  ["Texte secondaire sur blanc", "ink-muted", "surface", TEXT],
  ["Texte secondaire sur en-tête", "ink-muted", "panel", TEXT],
  ["Liens / accents sur blanc", "bordeaux", "surface", TEXT],
  ["Accents sur en-tête", "bordeaux", "panel", TEXT],
  ["Accents sur fond du chat", "bordeaux", "chat-bg", TEXT],
  ["Bouton principal (texte)", "on-accent", "bordeaux", TEXT],
  ["Pastille non-lus (texte)", "on-accent", "bordeaux", TEXT],
  ["Initiales des avatars", "beige-light", "bordeaux-dark", TEXT],
  ["Coches dans la liste (envoyé / reçu)", "ink-muted", "surface", UI],
  ["Coche « lu » dans la liste", "read-on-light", "surface", UI],
  ["Contour des champs de saisie", "field-border", "surface", UI],
  ["Erreurs sur blanc", "danger", "surface", TEXT],
  ["Erreurs sur fond du chat", "danger", "chat-bg", TEXT],
  ["Texte des écrans d'appel", "on-accent", "bordeaux-dark", TEXT],
];

let failures = 0;
for (const [label, fg, bg, min] of pairs) {
  const r = ratio(color(fg), color(bg));
  const ok = r >= min;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${r.toFixed(2).padStart(5)}:1  (min ${min}:1)  ${label}  [${fg} sur ${bg}]`);
}
console.log(failures ? `\n${failures} paire(s) sous le seuil WCAG AA.` : `\nToutes les paires respectent WCAG AA (${pairs.length}).`);
process.exit(failures ? 1 : 0);
