import { io, type Socket } from "socket.io-client";
import { refreshAccessToken, tokens } from "./api";

// Ouvre la connexion temps réel avec le backend.
// - `auth` est une FONCTION : elle est rappelée à chaque (re)connexion, donc on
//   envoie toujours l'access token le plus récent.
// - Si le serveur refuse (UNAUTHORIZED, token expiré), on renouvelle le token puis on
//   se reconnecte ; si c'est impossible, `onAuthFailure` renvoie vers la connexion.
export function createSocket(onAuthFailure: () => void): Socket {
  // Sans URL : même origine que la page → passe par le proxy Vite (/socket.io).
  const socket = io({
    auth: (cb) => cb({ token: tokens.access }),
    autoConnect: false,
  });

  let retried = false; // une seule tentative de renouvellement par échec, pour éviter une boucle
  socket.on("connect", () => {
    retried = false;
  });
  socket.on("connect_error", async (err) => {
    // Les autres erreurs (réseau, serveur arrêté) sont réessayées automatiquement par Socket.io.
    if (err.message !== "UNAUTHORIZED") return;
    if (!retried && (await refreshAccessToken())) {
      retried = true;
      socket.connect();
    } else {
      onAuthFailure();
    }
  });

  socket.connect();
  return socket;
}
