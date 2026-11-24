import http from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { attachPeerServer } from "../src/calls/peer.js";
import { signAccessToken } from "../src/auth/tokens.js";
import { prisma } from "../src/db.js";
import { attachSocket, type SocketOptions } from "../src/socket.js";

let counter = 0;

// Crée un utilisateur directement en base (plus rapide que /register) avec son access token.
export async function createUser(name = "Utilisateur") {
  counter += 1;
  const phone = `+3360000${String(counter).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, name, passwordHash: "non-utilisé-en-test" } });
  return { ...user, token: signAccessToken(user.id) };
}

// Démarre un vrai serveur HTTP + Socket.io sur un port libre (port 0 = choisi par l'OS).
export async function startServer(options?: SocketOptions) {
  const app = createApp();
  const server = http.createServer(app);
  const io = attachSocket(server, options);
  app.set("io", io); // comme index.ts : les routes de groupe diffusent en temps réel
  attachPeerServer(app, server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())), // ferme aussi le serveur HTTP
  };
}

// Connecte un client Socket.io. Résout une fois connecté, rejette si le serveur refuse.
export function connect(url: string, token?: string): Promise<ClientSocket> {
  const socket = ioClient(url, {
    auth: token ? { token } : {},
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}

// Attend le prochain événement `event` sur le socket (échoue après `timeout` ms).
export function waitFor<T = any>(socket: ClientSocket, event: string, timeout = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Événement "${event}" non reçu après ${timeout} ms`)), timeout);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Vérifie qu'un événement n'arrive PAS pendant `duration` ms.
export function expectNoEvent(socket: ClientSocket, event: string, duration = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => reject(new Error(`Événement "${event}" reçu alors qu'il ne devait pas l'être`));
    socket.once(event, onEvent);
    setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, duration);
  });
}
