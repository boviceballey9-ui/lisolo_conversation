import { Router } from "express";
import { pushSubscriptionSchema, pushUnsubscribeSchema } from "../chat/schemas.js";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";
import { deleteSubscription, saveSubscription } from "../push/service.js";

export const pushRouter = Router();
pushRouter.use(requireAuth);

// Clé publique VAPID : le navigateur la donne à son service push en s'abonnant.
// Le service push n'acceptera ensuite que les notifications signées par la clé privée correspondante.
pushRouter.get("/vapid-public-key", (_req, res, next) => {
  if (!config.push.enabled) return next(new HttpError(503, "Notifications push non configurées"));
  res.json({ publicKey: config.push.publicKey });
});

// Enregistrer (ou mettre à jour) l'abonnement de ce navigateur.
pushRouter.post("/subscriptions", validateBody(pushSubscriptionSchema), async (req, res, next) => {
  try {
    await saveSubscription(req.userId!, req.body);
    res.status(201).json({ subscribed: true });
  } catch (err) {
    next(err);
  }
});

// Se désabonner (bouton « Désactiver », ou déconnexion : le prochain utilisateur de ce
// navigateur ne doit pas recevoir les notifications du précédent).
pushRouter.delete("/subscriptions", validateBody(pushUnsubscribeSchema), async (req, res, next) => {
  try {
    res.json({ deleted: await deleteSubscription(req.userId!, req.body.endpoint) });
  } catch (err) {
    next(err);
  }
});
