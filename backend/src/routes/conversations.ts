import { Router } from "express";
import { listConversations, listMessages, startConversationByPhone } from "../chat/service.js";
import { conversationIdSchema, listMessagesQuerySchema, startConversationSchema } from "../chat/schemas.js";
import { notFound } from "../errors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth); // toutes les routes ci-dessous sont protégées

// Mes conversations, avec le dernier message et le nombre de non-lus.
conversationsRouter.get("/", async (req, res, next) => {
  try {
    res.json({ conversations: await listConversations(req.userId!) });
  } catch (err) {
    next(err);
  }
});

// Démarre (ou retrouve) une conversation privée à partir d'un numéro de téléphone.
conversationsRouter.post("/", validateBody(startConversationSchema), async (req, res, next) => {
  try {
    const conversation = await startConversationByPhone(req.userId!, req.body.phone);
    res.json({ conversation });
  } catch (err) {
    next(err);
  }
});

// Historique paginé : ?limit=30&before=<id du plus ancien message affiché>
conversationsRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const id = conversationIdSchema.safeParse(req.params.id);
    if (!id.success) throw notFound("Conversation introuvable");

    const query = listMessagesQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: "Paramètres invalides" });
    }
    res.json(await listMessages(req.userId!, id.data, query.data));
  } catch (err) {
    next(err);
  }
});
