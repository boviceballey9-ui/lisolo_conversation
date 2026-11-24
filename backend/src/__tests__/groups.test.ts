import type { Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createUser, expectNoEvent, startServer, waitFor } from "../../test/helpers.js";
import { listConversations, listMessages, markRead, sendMessage } from "../chat/service.js";
import { prisma } from "../db.js";

type TestUser = Awaited<ReturnType<typeof createUser>>;

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: ClientSocket[] = [];

// Les requêtes HTTP passent par le VRAI serveur (avec Socket.io), pour que les routes diffusent.
const api = () => request(server.url);
const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

async function client(user: TestUser) {
  const socket = await connect(server.url, user.token);
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

async function createGroup(admin: TestUser, members: TestUser[], name = "Amis") {
  const res = await api()
    .post("/api/groups")
    .set(auth(admin))
    .send({ name, phones: members.map((m) => m.phone) });
  expect(res.status).toBe(201);
  return res.body.conversation.id as string;
}

// Alice (admin), Bob et Carole (membres).
async function aliceBobCarole() {
  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const carole = await createUser("Carole");
  const groupId = await createGroup(alice, [bob, carole]);
  return { alice, bob, carole, groupId };
}

const roleOf = (groupId: string, userId: string) =>
  prisma.participant
    .findUnique({ where: { conversationId_userId: { conversationId: groupId, userId } } })
    .then((p) => p?.role ?? null);

const systemTexts = (groupId: string) =>
  prisma.message
    .findMany({ where: { conversationId: groupId, type: "SYSTEM" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
    .then((messages) => messages.map((m) => m.content));

// ---------------------------------------------------------------------------

describe("création d'un groupe", () => {
  it("le créateur devient admin, les autres membres, avec un message système", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const carole = await createUser("Carole");

    const res = await api()
      .post("/api/groups")
      .set(auth(alice))
      .send({ name: "Amis", phones: [bob.phone, carole.phone, bob.phone] }); // doublon ignoré

    expect(res.status).toBe(201);
    const conversation = res.body.conversation;
    expect(conversation).toMatchObject({ type: "GROUP", name: "Amis", otherUser: null, unreadCount: 0 });
    expect(conversation.members).toHaveLength(3);
    expect(conversation.members[0].user).not.toHaveProperty("passwordHash");
    expect(await roleOf(conversation.id, alice.id)).toBe("ADMIN");
    expect(await roleOf(conversation.id, bob.id)).toBe("MEMBER");
    expect(await roleOf(conversation.id, carole.id)).toBe("MEMBER");
    expect(conversation.lastMessage).toMatchObject({ type: "SYSTEM", content: "Alice a créé le groupe « Amis »" });
  });

  it("les messages système ne comptent pas comme non lus", async () => {
    const { bob, groupId } = await aliceBobCarole();
    const [summary] = await listConversations(bob.id, [groupId]);
    expect(summary.unreadCount).toBe(0);
    expect(summary.lastMessage?.type).toBe("SYSTEM");
  });

  it("refuse un numéro inconnu sans rien créer", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");

    const res = await api()
      .post("/api/groups")
      .set(auth(alice))
      .send({ name: "Amis", phones: [bob.phone, "+33799999999"] });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("+33799999999");
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("valide le nom et la liste de membres", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");

    const noName = await api().post("/api/groups").set(auth(alice)).send({ name: "  ", phones: [bob.phone] });
    const noMember = await api().post("/api/groups").set(auth(alice)).send({ name: "Amis", phones: [] });
    const onlyMe = await api().post("/api/groups").set(auth(alice)).send({ name: "Amis", phones: [alice.phone] });

    expect(noName.status).toBe(400);
    expect(noMember.status).toBe(400);
    expect(onlyMe.status).toBe(400);
  });

  it("exige d'être connecté", async () => {
    const res = await api().post("/api/groups").send({ name: "Amis", phones: ["+33600000001"] });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe("permissions : un membre non admin ne peut rien administrer", () => {
  it("ne peut pas retirer quelqu'un", async () => {
    const { bob, carole, groupId } = await aliceBobCarole();

    const res = await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(bob));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Réservé aux administrateurs du groupe");
    expect(await roleOf(groupId, carole.id)).toBe("MEMBER"); // toujours là
    expect(await systemTexts(groupId)).toHaveLength(1); // aucun message « a retiré »
  });

  it("ne peut pas ajouter de membre", async () => {
    const { bob, groupId } = await aliceBobCarole();
    const david = await createUser("David");

    const res = await api().post(`/api/groups/${groupId}/members`).set(auth(bob)).send({ phones: [david.phone] });

    expect(res.status).toBe(403);
    expect(await roleOf(groupId, david.id)).toBeNull();
  });

  it("ne peut pas nommer un admin (ni se nommer lui-même)", async () => {
    const { bob, carole, groupId } = await aliceBobCarole();

    const other = await api().post(`/api/groups/${groupId}/admins`).set(auth(bob)).send({ userId: carole.id });
    const self = await api().post(`/api/groups/${groupId}/admins`).set(auth(bob)).send({ userId: bob.id });

    expect(other.status).toBe(403);
    expect(self.status).toBe(403);
    expect(await roleOf(groupId, carole.id)).toBe("MEMBER");
    expect(await roleOf(groupId, bob.id)).toBe("MEMBER");
  });

  it("ne peut pas renommer le groupe", async () => {
    const { bob, groupId } = await aliceBobCarole();

    const res = await api().patch(`/api/groups/${groupId}`).set(auth(bob)).send({ name: "Piraté" });

    expect(res.status).toBe(403);
    const group = await prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    expect(group.name).toBe("Amis");
  });

  it("un non-membre reçoit 404 : il n'apprend même pas que le groupe existe", async () => {
    const { carole, groupId } = await aliceBobCarole();
    const eve = await createUser("Eve");

    const remove = await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(eve));
    const rename = await api().patch(`/api/groups/${groupId}`).set(auth(eve)).send({ name: "X" });
    const leave = await api().post(`/api/groups/${groupId}/leave`).set(auth(eve));
    const history = await api().get(`/api/conversations/${groupId}/messages`).set(auth(eve));

    expect([remove.status, rename.status, leave.status, history.status]).toEqual([404, 404, 404, 404]);
  });

  it("un id mal formé donne 404", async () => {
    const { alice } = await aliceBobCarole();
    const res = await api().patch("/api/groups/pas-un-uuid").set(auth(alice)).send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("actions d'un admin", () => {
  it("ajoute, nomme admin, renomme et retire, avec un message système à chaque fois", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const david = await createUser("David");
    const eve = await createUser("Eve");

    const add = await api()
      .post(`/api/groups/${groupId}/members`)
      .set(auth(alice))
      .send({ phones: [david.phone, eve.phone] });
    expect(add.status).toBe(200);
    expect(add.body.members).toHaveLength(5);

    expect((await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: bob.id })).status).toBe(200);
    expect((await api().patch(`/api/groups/${groupId}`).set(auth(alice)).send({ name: "Copains" })).status).toBe(200);
    expect((await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(alice))).status).toBe(200);

    expect(await roleOf(groupId, bob.id)).toBe("ADMIN");
    expect(await roleOf(groupId, carole.id)).toBeNull();
    expect(await systemTexts(groupId)).toEqual([
      "Alice a créé le groupe « Amis »",
      "Alice a ajouté David et Eve",
      "Alice a nommé Bob administrateur",
      "Alice a renommé le groupe en « Copains »",
      "Alice a retiré Carole",
    ]);
  });

  it("un membre promu admin obtient les droits", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: bob.id });

    const res = await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(bob));

    expect(res.status).toBe(200);
  });

  it("refuse les cas absurdes", async () => {
    const { alice, bob, groupId } = await aliceBobCarole();
    const stranger = await createUser("Inconnu");

    const removeSelf = await api().delete(`/api/groups/${groupId}/members/${alice.id}`).set(auth(alice));
    const promoteStranger = await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: stranger.id });
    const addExisting = await api().post(`/api/groups/${groupId}/members`).set(auth(alice)).send({ phones: [bob.phone] });
    await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: bob.id });
    const promoteTwice = await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: bob.id });

    expect(removeSelf.status).toBe(400);
    expect(promoteStranger.status).toBe(404);
    expect(addExisting.status).toBe(400);
    expect(promoteTwice.status).toBe(400);
  });

  it("un membre retiré ne voit plus le groupe", async () => {
    const { alice, carole, groupId } = await aliceBobCarole();
    await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(alice));

    const list = await api().get("/api/conversations").set(auth(carole));
    const history = await api().get(`/api/conversations/${groupId}/messages`).set(auth(carole));

    expect(list.body.conversations).toEqual([]);
    expect(history.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe("quitter un groupe", () => {
  it("un membre peut partir", async () => {
    const { bob, groupId } = await aliceBobCarole();

    const res = await api().post(`/api/groups/${groupId}/leave`).set(auth(bob));

    expect(res.status).toBe(200);
    expect(await roleOf(groupId, bob.id)).toBeNull();
    expect((await systemTexts(groupId)).at(-1)).toBe("Bob a quitté le groupe");
  });

  it("si le dernier admin part, le membre le plus ancien devient admin", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const carole = await createUser("Carole");
    const groupId = await createGroup(alice, [bob]);
    await api().post(`/api/groups/${groupId}/members`).set(auth(alice)).send({ phones: [carole.phone] }); // Carole arrive après Bob

    await api().post(`/api/groups/${groupId}/leave`).set(auth(alice));

    expect(await roleOf(groupId, bob.id)).toBe("ADMIN");
    expect(await roleOf(groupId, carole.id)).toBe("MEMBER");
    expect((await systemTexts(groupId)).slice(-2)).toEqual(["Alice a quitté le groupe", "Bob est maintenant administrateur"]);
  });

  it("pas de promotion automatique s'il reste un autre admin", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: carole.id });

    await api().post(`/api/groups/${groupId}/leave`).set(auth(alice));

    expect(await roleOf(groupId, bob.id)).toBe("MEMBER");
    expect(await roleOf(groupId, carole.id)).toBe("ADMIN");
  });

  it("deux admins qui partent en même temps laissent toujours un admin (verrou)", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    await api().post(`/api/groups/${groupId}/admins`).set(auth(alice)).send({ userId: bob.id });

    const [a, b] = await Promise.all([
      api().post(`/api/groups/${groupId}/leave`).set(auth(alice)),
      api().post(`/api/groups/${groupId}/leave`).set(auth(bob)),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await roleOf(groupId, carole.id)).toBe("ADMIN");
  });

  it("le groupe est supprimé quand le dernier membre part", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const groupId = await createGroup(alice, [bob]);

    await api().post(`/api/groups/${groupId}/leave`).set(auth(bob));
    await api().post(`/api/groups/${groupId}/leave`).set(auth(alice));

    expect(await prisma.conversation.findUnique({ where: { id: groupId } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("temps réel : room group:<id>", () => {
  it("un message de groupe arrive chez tous les membres et sur mes autres onglets, pas chez les autres", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const eve = await createUser("Eve");
    const alice1 = await client(alice);
    const alice2 = await client(alice);
    const bobSocket = await client(bob);
    const caroleSocket = await client(carole);
    const eveSocket = await client(eve);

    const received = Promise.all([
      waitFor(alice2, "message:new"),
      waitFor(bobSocket, "message:new"),
      waitFor(caroleSocket, "message:new"),
    ]);
    const noEcho = expectNoEvent(alice1, "message:new");
    const noLeak = expectNoEvent(eveSocket, "message:new");
    const ack = await alice1.emitWithAck("message:send", { conversationId: groupId, content: "Salut le groupe" });

    expect(ack.ok).toBe(true);
    for (const message of await received) expect(message).toMatchObject({ id: ack.message.id, content: "Salut le groupe" });
    await Promise.all([noEcho, noLeak]);
  });

  it("les membres connectés reçoivent la création, puis les messages, sans se reconnecter", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const bobSocket = await client(bob); // connecté AVANT que le groupe existe
    const aliceSocket = await client(alice);

    const created = waitFor(bobSocket, "message:new");
    const groupId = await createGroup(alice, [bob]);
    expect(await created).toMatchObject({ conversationId: groupId, type: "SYSTEM" });

    const next = waitFor(bobSocket, "message:new");
    await aliceSocket.emitWithAck("message:send", { conversationId: groupId, content: "Bienvenue" });
    expect(await next).toMatchObject({ content: "Bienvenue" });
  });

  it("un membre ajouté reçoit les messages suivants sans se reconnecter", async () => {
    const { alice, groupId } = await aliceBobCarole();
    const david = await createUser("David");
    const aliceSocket = await client(alice);
    const davidSocket = await client(david);

    const updated = waitFor(davidSocket, "group:updated");
    await api().post(`/api/groups/${groupId}/members`).set(auth(alice)).send({ phones: [david.phone] });
    expect((await updated).members).toHaveLength(4);

    const next = waitFor(davidSocket, "message:new");
    await aliceSocket.emitWithAck("message:send", { conversationId: groupId, content: "Salut David" });
    expect(await next).toMatchObject({ content: "Salut David" });
  });

  it("un membre retiré est prévenu, ne reçoit plus rien et ne peut plus écrire", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const aliceSocket = await client(alice);
    const bobSocket = await client(bob);
    const caroleSocket = await client(carole);

    const removed = waitFor(caroleSocket, "group:removed");
    const notice = waitFor(bobSocket, "message:new");
    await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(alice));
    expect(await removed).toEqual({ conversationId: groupId });
    expect(await notice).toMatchObject({ type: "SYSTEM", content: "Alice a retiré Carole" });

    const nothing = expectNoEvent(caroleSocket, "message:new");
    await aliceSocket.emitWithAck("message:send", { conversationId: groupId, content: "Carole ne voit pas ça" });
    await nothing;

    const ack = await caroleSocket.emitWithAck("message:send", { conversationId: groupId, content: "Je suis encore là ?" });
    expect(ack).toEqual({ ok: false, error: "Conversation introuvable" });
  });

  it("« en train d'écrire » est relayé aux autres membres avec l'id de celui qui écrit", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const aliceSocket = await client(alice);
    const bobSocket = await client(bob);
    const caroleSocket = await client(carole);

    const toAlice = waitFor(aliceSocket, "typing:update");
    const toCarole = waitFor(caroleSocket, "typing:update");
    const notToBob = expectNoEvent(bobSocket, "typing:update");
    await bobSocket.emitWithAck("typing:start", { conversationId: groupId });

    const expected = { conversationId: groupId, userId: bob.id, isTyping: true };
    expect(await toAlice).toEqual(expected);
    expect(await toCarole).toEqual(expected);
    await notToBob;
  });
});

// ---------------------------------------------------------------------------

describe("accusés de lecture en groupe", () => {
  it("✓✓ bleu seulement quand TOUS les membres ont lu", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const aliceSocket = await client(alice);
    const bobSocket = await client(bob);
    const { message } = await aliceSocket.emitWithAck("message:send", { conversationId: groupId, content: "Qui vient ?" });

    // Bob lit : SON statut est READ, mais le statut global reste celui de Carole (SENT).
    const bobRead = waitFor(aliceSocket, "message:status");
    await bobSocket.emitWithAck("message:read", { conversationId: groupId });
    expect(await bobRead).toMatchObject({ userId: bob.id, status: "READ", aggregates: [{ id: message.id, status: "SENT" }] });

    // Carole se connecte : reçu chez elle → global DELIVERED.
    const caroleDelivered = waitFor(aliceSocket, "message:status");
    const caroleSocket = await client(carole);
    expect(await caroleDelivered).toMatchObject({
      userId: carole.id,
      status: "DELIVERED",
      aggregates: [{ id: message.id, status: "DELIVERED" }],
    });

    // Carole lit : tout le monde a lu → bleu.
    const caroleRead = waitFor(aliceSocket, "message:status");
    await caroleSocket.emitWithAck("message:read", { conversationId: groupId });
    expect(await caroleRead).toMatchObject({ userId: carole.id, aggregates: [{ id: message.id, status: "READ" }] });

    const page = await listMessages(alice.id, groupId, { limit: 30 });
    expect(page.messages.find((m) => m.id === message.id)?.status).toBe("READ");
  });

  it("« Infos du message » liste qui a lu et quand, pour l'expéditeur seulement", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const { message } = await sendMessage(alice.id, { conversationId: groupId, content: "Rdv 20h" });
    await markRead(bob.id, groupId);

    const res = await api().get(`/api/conversations/${groupId}/messages/${message.id}/info`).set(auth(alice));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: message.id, status: "SENT" });
    const [bobInfo, caroleInfo] = res.body.recipients; // triés par nom
    expect(bobInfo).toMatchObject({ user: { id: bob.id, name: "Bob" }, status: "READ" });
    expect(bobInfo.readAt).not.toBeNull();
    expect(bobInfo.deliveredAt).not.toBeNull(); // lu directement : reçu au même moment
    expect(caroleInfo).toMatchObject({ user: { id: carole.id }, status: "SENT", deliveredAt: null, readAt: null });
    expect(bobInfo.user).not.toHaveProperty("passwordHash");

    const asBob = await api().get(`/api/conversations/${groupId}/messages/${message.id}/info`).set(auth(bob));
    expect(asBob.status).toBe(404);
  });

  it("un membre qui part sans avoir lu ne bloque plus le ✓✓ bleu", async () => {
    const { alice, bob, carole, groupId } = await aliceBobCarole();
    const { message } = await sendMessage(alice.id, { conversationId: groupId, content: "Important" });
    await markRead(bob.id, groupId);

    await api().post(`/api/groups/${groupId}/leave`).set(auth(carole));

    const page = await listMessages(alice.id, groupId, { limit: 30 });
    expect(page.messages.find((m) => m.id === message.id)?.status).toBe("READ");
  });
});
