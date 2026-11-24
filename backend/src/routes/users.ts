import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

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
