import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";

// Charge le .env situé à la racine du projet (un niveau au-dessus de backend/).
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });

const app = express();
app.use(cors());
app.use(express.json());

// Route de santé : permet de vérifier que le serveur répond.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const port = Number(process.env.BACKEND_PORT) || 4000;
app.listen(port, () => {
  console.log(`Backend démarré sur http://localhost:${port}`);
});
