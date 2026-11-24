import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../auth/tokens.js";

// Ajoute req.userId au type Request d'Express.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Protège une route : exige l'en-tête "Authorization: Bearer <access token>".
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentification requise" });
  }

  try {
    req.userId = verifyAccessToken(header.slice("Bearer ".length));
    next();
  } catch {
    // Expiré ou invalide : le frontend doit appeler /api/auth/refresh.
    res.status(401).json({ error: "Token invalide ou expiré" });
  }
}
