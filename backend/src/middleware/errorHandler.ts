import type { NextFunction, Request, Response } from "express";

// Dernier middleware : toute erreur non gérée devient un 500 générique.
// Le détail est journalisé côté serveur mais jamais renvoyé au client.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
}
