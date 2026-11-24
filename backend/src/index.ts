import "./env.js"; // doit rester le premier import (charge le .env)
import http from "node:http";
import { createApp } from "./app.js";
import { attachPeerServer } from "./calls/peer.js";
import { closeStaleCalls } from "./calls/service.js";
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

// Appels restés « en cours » si le serveur s'est arrêté brutalement (leur état vivait en mémoire).
const stale = await closeStaleCalls();
if (stale > 0) console.log(`${stale} appel(s) interrompu(s) clôturé(s)`);

const app = createApp();
const server = http.createServer(app);
// Les routes HTTP (ex. ajout d'un membre à un groupe) doivent pouvoir prévenir
// les clients connectés : on leur donne accès au serveur Socket.io via l'app.
app.set("io", attachSocket(server));
// Signalisation WebRTC des appels (PeerJS), sur le même port : ws://…/peerjs/peerjs
attachPeerServer(app, server);

const port = Number(process.env.BACKEND_PORT) || 4000;
// 127.0.0.1 par défaut : le backend n'est PAS joignable depuis le réseau, seulement via Nginx
// (qui le contacte par host.docker.internal, relayé vers la boucle locale par Docker Desktop)
// et via Vite en développement.
const host = process.env.BACKEND_HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Backend démarré sur http://${host}:${port}`);
});
