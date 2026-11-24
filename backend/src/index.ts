import "./env.js"; // doit rester le premier import (charge le .env)
import http from "node:http";
import { createApp } from "./app.js";
import { attachSocket } from "./socket.js";

// Express et Socket.io partagent le même serveur HTTP (et donc le même port) :
// les requêtes classiques vont à Express, les connexions /socket.io à Socket.io.
const app = createApp();
const server = http.createServer(app);
// Les routes HTTP (ex. ajout d'un membre à un groupe) doivent pouvoir prévenir
// les clients connectés : on leur donne accès au serveur Socket.io via l'app.
app.set("io", attachSocket(server));

const port = Number(process.env.BACKEND_PORT) || 4000;
server.listen(port, () => {
  console.log(`Backend démarré sur http://localhost:${port}`);
});
