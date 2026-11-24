import "./env.js"; // doit rester le premier import (charge le .env)
import cors from "cors";
import express from "express";
import { prisma } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

// Route de santé : vérifie que le serveur répond et que PostgreSQL est joignable.
app.get("/health", async (_req, res) => {
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
});

const port = Number(process.env.BACKEND_PORT) || 4000;
app.listen(port, () => {
  console.log(`Backend démarré sur http://localhost:${port}`);
});
