import type { Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { connect, createUser, expectNoEvent, startServer, waitFor } from "../../test/helpers.js";
import { turnCredential } from "../calls/ice.js";
import { listMessages, startConversationByPhone } from "../chat/service.js";
import { config } from "../config.js";
import { prisma } from "../db.js";

type TestUser = Awaited<ReturnType<typeof createUser>>;

const CALL_TIMEOUT_MS = 300; // au lieu de 30 s

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: ClientSocket[] = [];
const peerSockets: WebSocket[] = [];

beforeEach(async () => {
  server = await startServer({ callTimeoutMs: CALL_TIMEOUT_MS });
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  peerSockets.splice(0).forEach((ws) => ws.terminate());
  await server.close();
});

async function client(user: TestUser) {
  const socket = await connect(server.url, user.token);
  sockets.push(socket);
  return socket;
}

async function pair() {
  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const conversation = await startConversationByPhone(alice.id, bob.phone);
  return { alice, bob, conversationId: conversation!.id };
}

const statusOf = (callId: string) => prisma.call.findUniqueOrThrow({ where: { id: callId } }).then((c) => c.status);

// Alice appelle Bob (tous deux connectés) et Bob reçoit la sonnerie.
async function ringing(type: "AUDIO" | "VIDEO" = "VIDEO") {
  const { alice, bob, conversationId } = await pair();
  const aliceSocket = await client(alice);
  const bobSocket = await client(bob);
  const invited = waitFor(bobSocket, "call:invite");
  const ack = await aliceSocket.emitWithAck("call:invite", { conversationId, type });
  expect(ack.ok).toBe(true);
  return { alice, bob, conversationId, aliceSocket, bobSocket, callId: ack.call.id as string, invite: await invited };
}

// ---------------------------------------------------------------------------

describe("GET /api/calls/ice-config", () => {
  it("exige d'être connecté", async () => {
    expect((await request(server.url).get("/api/calls/ice-config")).status).toBe(401);
  });

  it("fournit STUN + TURN avec des identifiants temporaires propres à l'utilisateur", async () => {
    const alice = await createUser("Alice");
    const res = await request(server.url).get("/api/calls/ice-config").set({ Authorization: `Bearer ${alice.token}` });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const [stun, turn] = res.body.iceServers;
    expect(stun.urls).toMatch(/^stun:/);
    expect(turn.urls).toEqual(expect.arrayContaining([expect.stringMatching(/^turn:.*transport=udp$/)]));

    // username = "<expiration>:<userId>", expiration dans le futur (~12 h).
    const [expiry, userId] = turn.username.split(":");
    expect(userId).toBe(alice.id);
    expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000 + 11 * 3600);
    // credential = HMAC-SHA1(TURN_SECRET, username) : coturn refera exactement ce calcul.
    expect(turn.credential).toBe(turnCredential(config.turn.secret, turn.username));
    // Aucun secret fixe envoyé au navigateur.
    expect(JSON.stringify(res.body)).not.toContain(config.turn.secret);
    if (config.turn.password) expect(JSON.stringify(res.body)).not.toContain(config.turn.password);
  });
});

describe("PeerServer (/peerjs) protégé par le JWT", () => {
  // Ouvre un WebSocket PeerJS brut : résout avec le 1er message, ou rejette si la connexion est refusée.
  function peerConnect(id: string, token?: string): Promise<{ type: string }> {
    const url = new URL(server.url.replace("http", "ws") + "/peerjs/peerjs");
    url.searchParams.set("key", "peerjs");
    url.searchParams.set("id", id);
    if (token) url.searchParams.set("token", token);
    const ws = new WebSocket(url);
    peerSockets.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(String(data))));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  it("accepte mon id avec mon token", async () => {
    const alice = await createUser("Alice");
    expect(await peerConnect(alice.id, alice.token)).toEqual({ type: "OPEN" });
  });

  it("refuse l'id de quelqu'un d'autre, un token absent ou invalide", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");

    await expect(peerConnect(bob.id, alice.token)).rejects.toThrow("HTTP 401");
    await expect(peerConnect(alice.id)).rejects.toThrow("HTTP 401");
    await expect(peerConnect(alice.id, "pas.un.jwt")).rejects.toThrow("HTTP 401");
  });

  it("la découverte des pairs connectés est désactivée", async () => {
    const res = await request(server.url).get("/peerjs/peerjs/peers");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe("sonnerie via Socket.io", () => {
  it("parcours complet : invite → accept → end, avec historique dans la conversation", async () => {
    const { alice, bob, conversationId, aliceSocket, bobSocket, callId, invite } = await ringing("VIDEO");

    expect(invite.call).toMatchObject({ id: callId, type: "VIDEO", status: "RINGING", callerId: alice.id });
    expect(invite.caller).toMatchObject({ id: alice.id, name: "Alice" });
    expect(invite.caller).not.toHaveProperty("passwordHash");

    const accepted = waitFor(aliceSocket, "call:accept");
    const ack = await bobSocket.emitWithAck("call:accept", { callId });
    expect(ack.ok).toBe(true);
    expect((await accepted).call).toMatchObject({ id: callId, status: "ONGOING" });

    const endedForBob = waitFor(bobSocket, "call:end");
    const messageForBob = waitFor(bobSocket, "message:new");
    await aliceSocket.emitWithAck("call:end", { callId });

    const ended = (await endedForBob).call;
    expect(ended.status).toBe("COMPLETED");
    expect(ended.answeredAt).not.toBeNull();
    expect(ended.endedAt).not.toBeNull();
    expect(await messageForBob).toMatchObject({ type: "CALL", call: { id: callId, status: "COMPLETED", type: "VIDEO" } });

    const history = await listMessages(bob.id, conversationId, { limit: 30 });
    expect(history.messages.at(-1)).toMatchObject({ type: "CALL", senderId: alice.id, call: { id: callId } });
  });

  it("tous les onglets de l'appelé sonnent ; quand l'un décroche, les autres s'arrêtent", async () => {
    const { alice, bob, conversationId } = await pair();
    const aliceSocket = await client(alice);
    const bobTab1 = await client(bob);
    const bobTab2 = await client(bob);

    const rings = Promise.all([waitFor(bobTab1, "call:invite"), waitFor(bobTab2, "call:invite")]);
    const { call } = await aliceSocket.emitWithAck("call:invite", { conversationId, type: "AUDIO" });
    await rings;

    const stopRinging = waitFor(bobTab2, "call:accept");
    await bobTab1.emitWithAck("call:accept", { callId: call.id });
    await stopRinging;

    // Décrocher une 2e fois depuis l'autre onglet : refusé.
    expect(await bobTab2.emitWithAck("call:accept", { callId: call.id })).toEqual({
      ok: false,
      error: "Appel déjà décroché",
    });
  });

  it("refus : statut REJECTED, l'appelant et les autres onglets sont prévenus", async () => {
    const { bob, aliceSocket, bobSocket, callId } = await ringing();
    const bobTab2 = await client(bob);

    const toAlice = waitFor(aliceSocket, "call:reject");
    const toTab2 = waitFor(bobTab2, "call:reject");
    await bobSocket.emitWithAck("call:reject", { callId });

    expect((await toAlice).call.status).toBe("REJECTED");
    await toTab2;
    expect(await statusOf(callId)).toBe("REJECTED");
  });

  it("sans réponse au bout du délai : appel manqué", async () => {
    const { aliceSocket, bobSocket, callId } = await ringing();

    const [forAlice, forBob] = await Promise.all([
      waitFor(aliceSocket, "call:end", CALL_TIMEOUT_MS + 2000),
      waitFor(bobSocket, "call:end", CALL_TIMEOUT_MS + 2000),
    ]);

    expect(forAlice.call.status).toBe("MISSED");
    expect(forBob.call.answeredAt).toBeNull();
    expect(await prisma.message.count({ where: { callId } })).toBe(1);
  });

  it("l'appelant raccroche pendant la sonnerie : appel manqué", async () => {
    const { aliceSocket, bobSocket, callId } = await ringing();

    const toBob = waitFor(bobSocket, "call:end");
    await aliceSocket.emitWithAck("call:end", { callId });

    expect((await toBob).call.status).toBe("MISSED");
  });

  it("destinataire hors ligne : pas de sonnerie, appel manqué enregistré", async () => {
    const { alice, conversationId } = await pair();
    const aliceSocket = await client(alice);

    const ack = await aliceSocket.emitWithAck("call:invite", { conversationId, type: "AUDIO" });

    expect(ack).toMatchObject({ ok: true, reason: "OFFLINE", call: { status: "MISSED" } });
    expect(await prisma.message.count({ where: { callId: ack.call.id, type: "CALL" } })).toBe(1);
  });

  it("destinataire déjà en appel : occupé, et il n'est pas dérangé", async () => {
    const { bob, bobSocket, callId } = await ringing(); // Alice ↔ Bob
    await bobSocket.emitWithAck("call:accept", { callId });
    const carole = await createUser("Carole");
    const caroleConv = await startConversationByPhone(carole.id, bob.phone);
    const caroleSocket = await client(carole);

    const busy = waitFor(caroleSocket, "call:busy");
    const noRing = expectNoEvent(bobSocket, "call:invite");
    const ack = await caroleSocket.emitWithAck("call:invite", { conversationId: caroleConv!.id, type: "AUDIO" });

    expect(ack).toMatchObject({ ok: true, reason: "BUSY", call: { status: "BUSY" } });
    expect((await busy).call.id).toBe(ack.call.id);
    await noRing;
  });

  it("on ne peut pas appeler pendant un autre appel", async () => {
    const { aliceSocket, conversationId } = await ringing();

    const ack = await aliceSocket.emitWithAck("call:invite", { conversationId, type: "AUDIO" });

    expect(ack).toEqual({ ok: false, error: "Vous êtes déjà en appel" });
  });

  it("une fois l'appel terminé, on peut rappeler", async () => {
    const { aliceSocket, bobSocket, callId, conversationId } = await ringing();
    await bobSocket.emitWithAck("call:reject", { callId });

    const again = waitFor(bobSocket, "call:invite");
    const ack = await aliceSocket.emitWithAck("call:invite", { conversationId, type: "AUDIO" });

    expect(ack.ok).toBe(true);
    await again;
  });

  it("la déconnexion pendant un appel le termine chez l'autre", async () => {
    const { aliceSocket, bobSocket, callId } = await ringing();
    await bobSocket.emitWithAck("call:accept", { callId });

    const ended = waitFor(aliceSocket, "call:end");
    bobSocket.close();

    expect((await ended).call.status).toBe("COMPLETED");
  });
});

describe("permissions des appels", () => {
  it("conversation dont on n'est pas membre, ou groupe : refusé", async () => {
    const { conversationId } = await pair();
    const eve = await createUser("Eve");
    const bob = await createUser("Bob2");
    const eveSocket = await client(eve);
    const group = await request(server.url)
      .post("/api/groups")
      .set({ Authorization: `Bearer ${eve.token}` })
      .send({ name: "Amis", phones: [bob.phone] });

    const notMember = await eveSocket.emitWithAck("call:invite", { conversationId, type: "AUDIO" });
    const inGroup = await eveSocket.emitWithAck("call:invite", { conversationId: group.body.conversation.id, type: "AUDIO" });

    expect(notMember).toEqual({ ok: false, error: "Conversation introuvable" });
    expect(inGroup).toEqual({ ok: false, error: "Appels de groupe non pris en charge" });
  });

  it("seul l'appelé peut décrocher ou refuser ; un tiers ne peut pas raccrocher", async () => {
    const { aliceSocket, callId } = await ringing();
    const eve = await createUser("Eve");
    const eveSocket = await client(eve);

    expect(await aliceSocket.emitWithAck("call:accept", { callId })).toEqual({ ok: false, error: "Appel introuvable" });
    expect(await aliceSocket.emitWithAck("call:reject", { callId })).toEqual({ ok: false, error: "Appel introuvable" });
    expect(await eveSocket.emitWithAck("call:end", { callId })).toEqual({ ok: false, error: "Appel introuvable" });
    expect(await statusOf(callId)).toBe("RINGING");
  });

  it("valide les données", async () => {
    const { aliceSocket, conversationId } = await ringing();
    const ack = await aliceSocket.emitWithAck("call:invite", { conversationId, type: "HOLOGRAM" });
    expect(ack.ok).toBe(false);
  });
});
