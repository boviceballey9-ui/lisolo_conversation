import { useEffect, useState } from "react";

type Health = { status: string; uptime: number; timestamp: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Health>;
      })
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>WhatsApp Clone</h1>
      {error && <p style={{ color: "crimson" }}>Backend injoignable : {error}</p>}
      {health && (
        <p>
          Backend : <strong>{health.status}</strong> (démarré depuis {health.uptime.toFixed(0)} s)
        </p>
      )}
      {!health && !error && <p>Vérification du backend…</p>}
    </main>
  );
}
