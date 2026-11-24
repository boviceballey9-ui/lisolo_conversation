import { Router } from "express";
import { iceConfigFor } from "../calls/ice.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const callsRouter = Router();
callsRouter.use(requireAuth);

// Serveurs STUN/TURN à utiliser pour un appel. Les identifiants TURN sont propres à
// l'utilisateur et temporaires : rien n'est écrit en dur dans le frontend.
callsRouter.get("/ice-config", (req, res) => {
  res.set("Cache-Control", "no-store"); // contient des identifiants
  res.json(iceConfigFor(req.userId!));
});
