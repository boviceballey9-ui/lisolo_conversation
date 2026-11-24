// PeerServer (paquet « peer ») intégré à notre serveur HTTP, sur /peerjs.
//
// Rôle : relayer la SIGNALISATION WebRTC entre deux navigateurs (offre/réponse SDP,
// candidats ICE). Le son et l'image, eux, ne passent jamais par ici.
//
// Sécurité : l'id PeerJS d'un utilisateur est son id utilisateur. Sans contrôle, n'importe qui
// pourrait se connecter avec l'id d'un autre et recevoir ses appels. Le client PeerJS envoie
// son access token dans le paramètre `token` : on vérifie le JWT ET que son `sub` est bien l'id demandé.

import type http from "node:http";
import type { Duplex } from "node:stream";
import type { Express } from "express";
import { ExpressPeerServer } from "peer";
import { WebSocketServer, type ServerOptions } from "ws";
import { verifyAccessToken } from "../auth/tokens.js";

export const PEER_MOUNT = "/peerjs";

// Le JWT et l'id demandé correspondent-ils ?
export function authorizePeer(url: string | undefined): boolean {
  const params = new URL(url ?? "", "http://localhost").searchParams;
  const id = params.get("id");
  const token = params.get("token");
  if (!id || !token) return false;
  try {
    return verifyAccessToken(token) === id;
  } catch {
    return false;
  }
}

const reject = (socket: Duplex, status: string) => {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export function attachPeerServer(app: Express, server: http.Server) {
  const peerServer = ExpressPeerServer(server, {
    path: "/",
    allow_discovery: false, // ne JAMAIS lister les ids connectés
    // Piège : un WebSocketServer « ws » attaché au serveur HTTP (option `server`) répond 400
    // et COUPE toute connexion WebSocket dont le chemin n'est pas le sien… y compris /socket.io.
    // On le crée donc en mode `noServer` et on lui transmet nous-mêmes uniquement ses connexions,
    // après vérification du JWT.
    createWebSocketServer: (options: ServerOptions) => {
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        const pathname = new URL(req.url ?? "", "http://localhost").pathname;
        if (pathname !== options.path) return; // pas pour nous (ex. Socket.io)
        if (!authorizePeer(req.url)) return reject(socket, "401 Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
      return wss;
    },
  });
  app.use(PEER_MOUNT, peerServer);
  return peerServer;
}
