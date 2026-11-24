import cors from "cors";
import express, { type Request, type Response } from "express";
import { prisma } from "./db.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";

// Construit l'application Express SANS démarrer le serveur :
// index.ts appelle listen(), les tests passent l'app directement à Supertest.
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Santé : vérifie que le serveur répond et que PostgreSQL est joignable.
  const health = async (_req: Request, res: Response) => {
    let database: "ok" | "error" = "ok";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = "error";
    }
    res.status(database === "ok" ? 200 : 503).json({
      status: database === "ok" ? "ok" : "degraded",
      database,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  };
  app.get("/health", health); // pour les outils de supervision
  app.get("/api/health", health); // pour le frontend (via le proxy Vite)

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);

  app.use(errorHandler);
  return app;
}
