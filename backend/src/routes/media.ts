import { Router } from "express";
import { z } from "zod";
import { registerMediaSchema, uploadUrlSchema } from "../chat/schemas.js";
import { notFound } from "../errors.js";
import { registerUpload, readUrl, requestUpload } from "../media/service.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";
import { publicOriginOf } from "../publicOrigin.js";

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

// 1. Demander une URL d'envoi. Le backend vérifie type et taille, puis signe un PUT
//    valable 5 minutes. Le fichier lui-même n'est PAS envoyé ici.
mediaRouter.post("/upload-url", validateBody(uploadUrlSchema), async (req, res, next) => {
  try {
    res.json(await requestUpload(req.userId!, req.body, publicOriginOf(req)));
  } catch (err) {
    next(err);
  }
});

// 3. Après l'envoi direct à MinIO : vérifier l'objet et créer la ligne `media`.
mediaRouter.post("/", validateBody(registerMediaSchema), async (req, res, next) => {
  try {
    res.status(201).json({ media: await registerUpload(req.userId!, req.body) });
  } catch (err) {
    next(err);
  }
});

// Lire un média : URL présignée GET de courte durée, si j'y ai droit.
mediaRouter.get("/:id/url", async (req, res, next) => {
  try {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound("Média introuvable");
    res.json(await readUrl(req.userId!, id.data, publicOriginOf(req)));
  } catch (err) {
    next(err);
  }
});
