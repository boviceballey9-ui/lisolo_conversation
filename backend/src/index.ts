import "./env.js"; // doit rester le premier import (charge le .env)
import http from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { attachSocket } from "./socket.js";
import { ensureBucket } from "./storage.js";

// Le bucket des médias doit exister avant le premier envoi de fichier.
// Si MinIO est arrêté, on le signale clairement mais le chat texte reste utilisable.
try {
  await ensureBucket();
} catch (err) {
  console.error(
    `MinIO injoignable (${config.storage.endpoint}) : les médias ne fonctionneront pas.`,
    "Lancez `docker compose up -d`.",
    err instanceof Error ? err.message : err,
  );
}

const app = createApp();
const server = http.createServer(app);
// Les routes HTTP (ex. ajout d'un membre à un groupe) doivent pouvoir prévenir
// les clients connectés : on leur donne accès au serveur Socket.io via l'app.
app.set("io", attachSocket(server));

const port = Number(process.env.BACKEND_PORT) || 4000;
server.listen(port, () => {
  console.log(`Backend démarré sur http://localhost:${port}`);
});
