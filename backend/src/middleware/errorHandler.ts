import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../errors.js";

// Dernier middleware : les HttpError deviennent leur code HTTP,
// toute autre erreur devient un 500 générique.
// Le détail est journalisé côté serveur mais jamais renvoyé au client.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
}
