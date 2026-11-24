import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createUser, expectNoEvent, startServer, waitFor } from "../../test/helpers.js";
import { startConversationByPhone } from "../chat/service.js";
import { prisma } from "../db.js";

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: ClientSocket[] = [];

// Connecte un client et le mémorise pour le fermer après le test.
async function client(token?: string) {
  const socket = await connect(server.url, token);
  sockets.push(socket);
  return socket;
}

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await server.close();
});

// Alice et Bob avec une conversation privée.
async function aliceAndBob() {
  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const conversation = await startConversationByPhone(alice.id, bob.phone);
  return { alice, bob, conversationId: conversation!.id };
}

const statusOf = (messageId: string, userId: string) =>
  prisma.messageStatus.findUniqueOrThrow({ where: { messageId_userId: { messageId, userId } } }).then((s) => s.status);

describe("authentification du socket", () => {
  it("refuse la connexion sans token", async () => {
    await expect(client()).rejects.toThrow("UNAUTHORIZED");
  });

  it("refuse la connexion avec un token invalide", async () => {
    await expect(client("pas.un.token")).rejects.toThrow("UNAUTHORIZED");
  });

  it("accepte la connexion avec un access token valide", async () => {
    const alice = await createUser("Alice");
    const socket = await client(alice.token);

    expect(socket.connected).toBe(true);
  });
});

describe("message:send", () => {
  it("enregistre le message, l'acquitte, et le livre au destinataire", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);

    const received = waitFor(bobSocket, "message:new");
    const ack = await aliceSocket.emitWithAck("message:send", { conversationId, content: "  Salut Bob !  ", clientId: "tmp-1" });

    expect(ack).toMatchObject({ ok: true, clientId: "tmp-1", message: { content: "Salut Bob !", status: "SENT" } });
    const message = await received;
    expect(message).toMatchObject({ id: ack.message.id, conversationId, senderId: alice.id, content: "Salut Bob !" });

    const saved = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(saved.content).toBe("Salut Bob !");
    expect(await statusOf(message.id, bob.id)).toBe("SENT");
  });

  it("transmet le message aux autres appareils de l'expéditeur, mais pas à l'émetteur", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const alicePhone = await client(alice.token);
    const aliceLaptop = await client(alice.token);
    await client(bob.token);

    const onLaptop = waitFor(aliceLaptop, "message:new");
    const notOnPhone = expectNoEvent(alicePhone, "message:new");
    await alicePhone.emitWithAck("message:send", { conversationId, content: "Multi-appareils" });

    expect((await onLaptop).content).toBe("Multi-appareils");
    await notOnPhone;
  });

  it("refuse d'écrire dans une conversation dont on n'est pas membre", async () => {
    const { conversationId } = await aliceAndBob();
    const eve = await createUser("Eve");
    const eveSocket = await client(eve.token);

    const ack = await eveSocket.emitWithAck("message:send", { conversationId, content: "Intrusion" });

    expect(ack).toEqual({ ok: false, error: "Conversation introuvable" });
    expect(await prisma.message.count()).toBe(0);
  });

  it("refuse un message vide", async () => {
    const { alice, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice.token);

    const ack = await aliceSocket.emitWithAck("message:send", { conversationId, content: "   " });

    expect(ack).toEqual({ ok: false, error: "Message vide" });
  });

  it("refuse un payload invalide sans faire tomber le serveur", async () => {
    const alice = await createUser("Alice");
    const aliceSocket = await client(alice.token);

    const ack = await aliceSocket.emitWithAck("message:send", { conversationId: "nope" });

    expect(ack.ok).toBe(false);
    expect(aliceSocket.connected).toBe(true);
  });
});

describe("accusés de réception", () => {
  it("✓✓ reçu puis ✓✓ bleu lu : la base est mise à jour et l'expéditeur est prévenu", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);
    const { message } = await aliceSocket.emitWithAck("message:send", { conversationId, content: "Coucou" });

    const delivered = waitFor(aliceSocket, "message:status");
    await bobSocket.emitWithAck("message:delivered", { messageIds: [message.id] });
    expect(await delivered).toEqual({
      conversationId,
      messageIds: [message.id],
      userId: bob.id,
      status: "DELIVERED",
      aggregates: [{ id: message.id, status: "DELIVERED" }], // 1-à-1 : statut global = celui de Bob
    });
    expect(await statusOf(message.id, bob.id)).toBe("DELIVERED");

    const read = waitFor(aliceSocket, "message:status");
    await bobSocket.emitWithAck("message:read", { conversationId });
    expect(await read).toEqual({
      conversationId,
      messageIds: [message.id],
      userId: bob.id,
      status: "READ",
      aggregates: [{ id: message.id, status: "READ" }],
    });
    expect(await statusOf(message.id, bob.id)).toBe("READ");
  });

  it("ne revient jamais en arrière : un message lu reste lu", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice.token);
    const bobSocket = await client(bob.token);
    const { message } = await aliceSocket.emitWithAck("message:send", { conversationId, content: "Coucou" });
    await bobSocket.emitWithAck("message:read", { conversationId });

    const noStatus = expectNoEvent(aliceSocket, "message:status");
    await bobSocket.emitWithAck("message:delivered", { messageIds: [message.id] });

    await noStatus;
    expect(await statusOf(message.id, bob.id)).toBe("READ");
  });

  it("l'expéditeur ne peut pas marquer ses propres messages comme lus", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice.token);
    const { message } = await aliceSocket.emitWithAck("message:send", { conversationId, content: "Coucou" });

    await aliceSocket.emitWithAck("message:read", { conversationId });

    expect(await statusOf(message.id, bob.id)).toBe("SENT");
  });

  it("messages reçus hors ligne : passent à « reçu » quand le destinataire se connecte", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice.token);
    const { message } = await aliceSocket.emitWithAck("message:send", { conversationId, content: "Tu es là ?" });
    expect(await statusOf(message.id, bob.id)).toBe("SENT");

    const delivered = waitFor(aliceSocket, "message:status");
    await client(bob.token); // Bob se connecte

    expect(await delivered).toMatchObject({ messageIds: [message.id], userId: bob.id, status: "DELIVERED" });
    expect(await statusOf(message.id, bob.id)).toBe("DELIVERED");
  });
});
