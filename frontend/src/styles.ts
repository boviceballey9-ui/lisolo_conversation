import type { CSSProperties } from "react";

// Styles en ligne des pages Connexion / Inscription.
// Les couleurs viennent des variables CSS de la charte Lisolo (:root dans chat.css),
// vérifiées par `npm run check:contrast` : une seule source de vérité.
export const styles = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 16,
    background: "var(--beige-light)",
    fontFamily: "system-ui, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 380,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 28,
    background: "var(--surface)",
    borderRadius: 12,
    boxShadow: "0 2px 12px var(--shadow)",
  },
  logo: { display: "block", width: 200, height: "auto", margin: "0 auto 6px" },
  title: { margin: 0, color: "var(--bordeaux-dark)", fontSize: 22, textAlign: "center" },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, color: "var(--ink)" },
  input: { padding: "10px 12px", fontSize: 16, border: "1px solid var(--field-border)", borderRadius: 8 },
  button: {
    padding: "12px",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--on-accent)",
    background: "var(--bordeaux)",
    border: "none",
    borderRadius: 24,
    cursor: "pointer",
  },
  error: { margin: 0, padding: 10, color: "var(--danger)", background: "#fef3f2", borderRadius: 8 },
  fieldError: { color: "var(--danger)", fontSize: 13 },
  footer: { margin: 0, fontSize: 14, textAlign: "center", color: "var(--ink-muted)" },
} satisfies Record<string, CSSProperties>;
