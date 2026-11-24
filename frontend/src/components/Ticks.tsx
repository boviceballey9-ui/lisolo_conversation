import type { DeliveryStatus } from "../api";

// Indicateur d'état d'un message envoyé :
// 🕓 en attente (pas encore confirmé par le serveur), ✓ envoyé, ✓✓ reçu, ✓✓ bleu lu.
export function Ticks({ status, pending }: { status: DeliveryStatus; pending?: boolean }) {
  if (pending) {
    return (
      <svg className="ticks" viewBox="0 0 16 16" width="14" height="14" aria-label="En attente">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  const label = { SENT: "Envoyé", DELIVERED: "Reçu", READ: "Lu" }[status];
  return (
    <svg
      className={`ticks${status === "READ" ? " ticks--read" : ""}`}
      viewBox="0 0 18 12"
      width="17"
      height="12"
      aria-label={label}
    >
      <path d="M1 6.5 4.5 10 11 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {status !== "SENT" && (
        <path d="M7.5 10 8 10.5 14.5 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
