import { Router, type Request } from "express";
import type { Server } from "socket.io";
import { z } from "zod";
import {
  addMembers,
  createGroup,
  leaveGroup,
  promoteAdmin,
  removeMember,
  renameGroup,
  type GroupEffects,
} from "../chat/groups.js";
import { addMembersSchema, createGroupSchema, promoteAdminSchema, renameGroupSchema } from "../chat/schemas.js";
import { notFound } from "../errors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";
import { broadcastGroupEffects } from "../socket.js";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const uuid = z.uuid();
// Un id mal formé ne peut désigner aucun groupe / membre : 404.
const param = (req: Request, name: string) => {
  const parsed = uuid.safeParse(req.params[name]);
  if (!parsed.success) throw notFound("Groupe introuvable");
  return parsed.data;
};

// Prévient les membres en temps réel. Le serveur Socket.io est rangé dans l'app par
// index.ts (app.set("io", io)) ; absent dans les tests HTTP purs : on ne diffuse rien.
const broadcast = (req: Request, effects: GroupEffects) => {
  const io = req.app.get("io") as Server | undefined;
  if (io) broadcastGroupEffects(io, effects);
};

// Créer un groupe : le créateur en devient admin.
groupsRouter.post("/", validateBody(createGroupSchema), async (req, res, next) => {
  try {
    const { conversation, effects } = await createGroup(req.userId!, req.body);
    broadcast(req, effects);
    res.status(201).json({ conversation });
  } catch (err) {
    next(err);
  }
});

// Renommer (admin).
groupsRouter.patch("/:id", validateBody(renameGroupSchema), async (req, res, next) => {
  try {
    const effects = await renameGroup(req.userId!, param(req, "id"), req.body.name);
    broadcast(req, effects);
    res.json({ name: effects.name, members: effects.members });
  } catch (err) {
    next(err);
  }
});

// Ajouter des membres par numéro (admin).
groupsRouter.post("/:id/members", validateBody(addMembersSchema), async (req, res, next) => {
  try {
    const effects = await addMembers(req.userId!, param(req, "id"), req.body.phones);
    broadcast(req, effects);
    res.json({ name: effects.name, members: effects.members });
  } catch (err) {
    next(err);
  }
});

// Retirer un membre (admin).
groupsRouter.delete("/:id/members/:userId", async (req, res, next) => {
  try {
    const effects = await removeMember(req.userId!, param(req, "id"), param(req, "userId"));
    broadcast(req, effects);
    res.json({ name: effects.name, members: effects.members });
  } catch (err) {
    next(err);
  }
});

// Nommer un autre membre administrateur (admin).
groupsRouter.post("/:id/admins", validateBody(promoteAdminSchema), async (req, res, next) => {
  try {
    const effects = await promoteAdmin(req.userId!, param(req, "id"), req.body.userId);
    broadcast(req, effects);
    res.json({ name: effects.name, members: effects.members });
  } catch (err) {
    next(err);
  }
});

// Quitter le groupe (n'importe quel membre).
groupsRouter.post("/:id/leave", async (req, res, next) => {
  try {
    const effects = await leaveGroup(req.userId!, param(req, "id"));
    broadcast(req, effects);
    res.json({ left: true });
  } catch (err) {
    next(err);
  }
});
