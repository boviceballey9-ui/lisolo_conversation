import type { CSSProperties } from "react";

// Styles minimalistes en ligne (pas de framework CSS pour l'instant).
const green = "#008069";

export const styles = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 16,
    background: "#f0f2f5",
    fontFamily: "system-ui, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 380,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 28,
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 2px 12px rgba(0,0,0,.08)",
  },
  title: { margin: 0, color: green, fontSize: 24 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, color: "#3b4a54" },
  input: { padding: "10px 12px", fontSize: 16, border: "1px solid #d1d7db", borderRadius: 8 },
  button: {
    padding: "12px",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    background: green,
    border: "none",
    borderRadius: 24,
    cursor: "pointer",
  },
  error: { margin: 0, padding: 10, color: "#b42318", background: "#fef3f2", borderRadius: 8 },
  fieldError: { color: "#b42318", fontSize: 13 },
  footer: { margin: 0, fontSize: 14, textAlign: "center" },
} satisfies Record<string, CSSProperties>;
