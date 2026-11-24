import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password.js";
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type LoginInput,
  type RefreshInput,
  type RegisterInput,
} from "../auth/schemas.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../auth/tokens.js";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { publicUserSelect } from "./users.js";

export const authRouter = Router();

function issueTokens(userId: string) {
  return {
    accessToken: signAccessToken(userId),
    refreshToken: signRefreshToken(userId),
  };
}

// Express 5 n'est pas utilisé : on transmet les erreurs async à next() nous-mêmes.
authRouter.post("/register", validateBody(registerSchema), async (req, res, next) => {
  const { phone, name, password } = req.body as RegisterInput;
  try {
    const user = await prisma.user.create({
      data: { phone, name, passwordHash: await hashPassword(password) },
      select: publicUserSelect,
    });
    res.status(201).json({ user, ...issueTokens(user.id) });
  } catch (err) {
    // P2002 = violation d'unicité (ici : téléphone déjà utilisé).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "Ce numéro est déjà utilisé" });
    }
    next(err);
  }
});

authRouter.post("/login", validateBody(loginSchema), async (req, res, next) => {
  const { phone, password } = req.body as LoginInput;
  try {
    const user = await prisma.user.findUnique({ where: { phone } });
    // Comparaison faite même si l'utilisateur n'existe pas (temps de réponse constant),
    // et même message d'erreur dans les deux cas : on ne révèle pas quels numéros ont un compte.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: "Numéro ou mot de passe incorrect" });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    const { passwordHash: _omit, ...publicUser } = user;
    res.json({ user: publicUser, ...issueTokens(user.id) });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/refresh", validateBody(refreshSchema), async (req, res, next) => {
  const { refreshToken } = req.body as RefreshInput;
  let userId: string;
  try {
    userId = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: "Refresh token invalide ou expiré" });
  }

  try {
    // Le compte peut avoir été supprimé depuis l'émission du refresh token.
    const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) {
      return res.status(401).json({ error: "Refresh token invalide ou expiré" });
    }
    res.json({ accessToken: signAccessToken(userId) });
  } catch (err) {
    next(err);
  }
});
