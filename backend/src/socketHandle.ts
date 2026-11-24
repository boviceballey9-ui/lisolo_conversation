import type { Socket } from "socket.io";
import type { z } from "zod";
import { HttpError } from "./errors.js";

export type Ack = (response: { ok: boolean; error?: string; [key: string]: unknown }) => void;

// Enregistre un handler d'événement : valide le payload avec Zod, exécute,
// et répond via l'ack. Une erreur ne fait jamais tomber le serveur.
export function handle<S extends z.ZodType>(
  socket: Socket,
  event: string,
  schema: S,
  fn: (data: z.infer<S>) => Promise<Record<string, unknown>>,
) {
  socket.on(event, async (payload: unknown, ack?: Ack) => {
    const reply: Ack = typeof ack === "function" ? ack : () => {};
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return reply({ ok: false, error: parsed.error.issues[0]?.message ?? "Données invalides" });
    }
    try {
      reply({ ok: true, ...(await fn(parsed.data)) });
    } catch (err) {
      if (err instanceof HttpError) return reply({ ok: false, error: err.message });
      console.error(err);
      reply({ ok: false, error: "Erreur interne du serveur" });
    }
  });
}
