import { Router } from "express";
import { prisma } from "../db.js";
import { setPhotoSchema } from "../chat/schemas.js";
import { badRequest } from "../errors.js";
import { ownMedia } from "../media/service.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";

// Champs d'un utilisateur qu'on peut renvoyer au client (jamais passwordHash).
export const publicUserSelect = {
  id: true,
  phone: true,
  name: true,
  about: true,
  avatarId: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: publicUserSelect,
    });
    if (!user) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// Ma photo de profil : { mediaId } d'une image que j'ai envoyée, ou null pour la retirer.
usersRouter.patch("/me/avatar", requireAuth, validateBody(setPhotoSchema), async (req, res, next) => {
  try {
    const { mediaId } = req.body as { mediaId: string | null };
    if (mediaId) {
      const media = await ownMedia(req.userId!, mediaId);
      if (media.category !== "IMAGE") throw badRequest("La photo de profil doit être une image");
    }
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { avatarId: mediaId },
      select: publicUserSelect,
    });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});
