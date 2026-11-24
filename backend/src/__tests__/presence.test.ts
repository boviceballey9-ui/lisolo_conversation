import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createUser, expectNoEvent, startServer, waitFor } from "../../test/helpers.js";
import { startConversationByPhone } from "../chat/service.js";
import { prisma } from "../db.js";

// Délai d'arrêt automatique de la saisie, raccourci pour que les tests restent rapides.
const TYPING_TIMEOUT_MS = 200;

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: ClientSocket[] = [];

async function client(token: string) {
  const socket = await connect(server.url, token);
  sockets.push(socket);
  return socket;
}

// Ferme un socket (simule la fermeture d'un onglet).
function close(socket: ClientSocket) {
  socket.close();
}

beforeEach(async () => {
  server = await startServer({ typingTimeoutMs: TYPING_TIMEOUT_MS });
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await server.close();
});

// Alice et Bob ont une conversation (donc sont contacts) ; Carol ne connaît personne.
async function setup() {
  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const carol = await createUser("Carol");
  const conversation = await startConversationByPhone(alice.id, bob.phone);
  return { alice, bob, carol, conversationId: conversation!.id };
}

describe("présence en ligne / hors ligne", () => {
  it("prévient mes contacts quand je me connecte", async () => {
    const { alice, bob } = await setup();
    const bobSocket = await client(bob.token);

    const update = waitFor(bobSocket, "presence:update");
    await client(alice.token);

    expect(await update).toEqual({ userId: alice.id, online: true, lastSeenAt: null });
  });

  it("ne passe hors ligne qu'à la fermeture du DERNIER onglet, et enregistre last_seen_at", async () => {
    const { alice, bob } = await setup();
    const bobSocket = await client(bob.token);
    const firstOnline = waitFor(bobSocket, "presence:update");
    const tab1 = await client(alice.token);
    await firstOnline;

    // Le 2e onglet ne provoque pas de nouvel « en ligne »…
    const noDuplicateOnline = expectNoEvent(bobSocket, "presence:update");
    const tab2 = await client(alice.token);
    await noDuplicateOnline;

    // …fermer le 1er onglet ne rend pas Alice hors ligne…
    const stillOnline = expectNoEvent(bobSocket, "presence:update");
    close(tab1);
    await stillOnline;

    // …fermer le dernier, si.
    const offline = waitFor(bobSocket, "presence:update");
    const before = Date.now();
    close(tab2);
    const update = await offline;

    expect(update).toMatchObject({ userId: alice.id, online: false });
    const lastSeen = new Date(update.lastSeenAt).getTime();
    expect(lastSeen).toBeGreaterThanOrEqual(before - 1000);

    const saved = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(saved.lastSeenAt?.getTime()).toBe(lastSeen);
  });

  it("ne prévient pas les utilisateurs qui ne sont pas des contacts", async () => {
    const { alice, carol } = await setup();
    const carolSocket = await client(carol.token);

    const nothing = expectNoEvent(carolSocket, "presence:update");
    const aliceSocket = await client(alice.token);
    close(aliceSocket);

    await nothing;
  });

  it("presence:get renvoie l'état actuel de mes contacts, et rien sur les inconnus", async () => {
    const { alice, bob, carol } = await setup();
    const lastSeenAt = new Date("2026-11-20T08:30:00Z");
    await prisma.user.update({ where: { id: bob.id }, data: { lastSeenAt } });
    const aliceSocket = await client(alice.token);

    // Bob hors ligne
    const offline = await aliceSocket.emitWithAck("presence:get", { userIds: [bob.id, carol.id] });
    expect(offline).toEqual({
      ok: true,
      presence: [{ userId: bob.id, online: false, lastSeenAt: lastSeenAt.toISOString() }],
    });

    // Bob en ligne
    const online = waitFor(aliceSocket, "presence:update");
    await client(bob.token);
    await online;
    const res = await aliceSocket.emitWithAck("presence:get", { userIds: [bob.id] });
    expect(res.presence).toEqual([{ userId: bob.id, online: true, lastSeenAt: lastSeenAt.toISOString() }]);
  });
});

describe("en train d'écrire", () => {
  it("typing:start / typing:stop sont relayés au destinataire, pas à l'auteur", async () => {
    const { alice, bob, conversationId } = await setup();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);

    const started = waitFor(bobSocket, "typing:update");
    // Fenêtre plus courte que le délai d'arrêt automatique, sinon l'arrêt auto passerait avant typing:stop.
    const notToAuthor = expectNoEvent(aliceSocket, "typing:update", TYPING_TIMEOUT_MS / 4);
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    expect(await started).toEqual({ conversationId, userId: alice.id, isTyping: true });
    await notToAuthor;

    const stopped = waitFor(bobSocket, "typing:update");
    await aliceSocket.emitWithAck("typing:stop", { conversationId });
    expect(await stopped).toEqual({ conversationId, userId: alice.id, isTyping: false });
  });

  it("des typing:start répétés n'envoient qu'un seul événement", async () => {
    const { alice, bob, conversationId } = await setup();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);

    const started = waitFor(bobSocket, "typing:update");
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    await started;

    const noRepeat = expectNoEvent(bobSocket, "typing:update", TYPING_TIMEOUT_MS / 2);
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    await noRepeat;
  });

  it("s'arrête tout seul après le délai sans nouveau typing:start", async () => {
    const { alice, bob, conversationId } = await setup();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);

    const started = waitFor(bobSocket, "typing:update");
    const t0 = Date.now();
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    await started;

    const stopped = await waitFor(bobSocket, "typing:update", TYPING_TIMEOUT_MS * 5);
    expect(stopped).toMatchObject({ userId: alice.id, isTyping: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(TYPING_TIMEOUT_MS - 20);
  });

  it("un nouveau typing:start relance le délai", async () => {
    const { alice, bob, conversationId } = await setup();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);

    const started = waitFor(bobSocket, "typing:update");
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    await started;

    // On continue de « taper » régulièrement, plus longtemps que le délai.
    const noStop = expectNoEvent(bobSocket, "typing:update", TYPING_TIMEOUT_MS * 2);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, TYPING_TIMEOUT_MS / 2));
      await aliceSocket.emitWithAck("typing:start", { conversationId });
    }
    await noStop;
  });

  it("s'arrête quand l'auteur envoie son message", async () => {
    const { alice, bob, conversationId } = await setup();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);
    const started = waitFor(bobSocket, "typing:update");
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    await started;

    const stopped = waitFor(bobSocket, "typing:update");
    await aliceSocket.emitWithAck("message:send", { conversationId, content: "Voilà !" });

    expect(await stopped).toMatchObject({ isTyping: false });
  });

  it("s'arrête quand l'auteur se déconnecte", async () => {
    const { alice, bob, conversationId } = await setup();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);
    const started = waitFor(bobSocket, "typing:update");
    await aliceSocket.emitWithAck("typing:start", { conversationId });
    await started;

    const stopped = waitFor(bobSocket, "typing:update");
    close(aliceSocket);

    expect(await stopped).toMatchObject({ userId: alice.id, isTyping: false });
  });

  it("refuse de signaler une saisie dans une conversation dont on n'est pas membre", async () => {
    const { bob, carol, conversationId } = await setup();
    const bobSocket = await client(bob.token);
    const carolSocket = await client(carol.token);

    const nothing = expectNoEvent(bobSocket, "typing:update");
    const ack = await carolSocket.emitWithAck("typing:start", { conversationId });

    expect(ack).toEqual({ ok: false, error: "Conversation introuvable" });
    await nothing;
  });
});
