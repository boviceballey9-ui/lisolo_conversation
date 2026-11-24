import type { Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createUser, startServer, waitFor } from "../../test/helpers.js";
import { startConversationByPhone } from "../chat/service.js";
import { prisma } from "../db.js";
import { headObject } from "../storage.js";

// Ces tests parlent au VRAI MinIO (bucket de test « media-test », vidé au début de `npm test`).

type TestUser = Awaited<ReturnType<typeof createUser>>;

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: ClientSocket[] = [];
const api = () => request(server.url);
const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });
const MB = 1024 * 1024;

// Image PNG de 1×1 pixel.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n% faux document de test\n");

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await server.close();
});

async function client(user: TestUser) {
  const socket = await connect(server.url, user.token);
  sockets.push(socket);
  return socket;
}

const askUploadUrl = (user: TestUser, body: { mimeType: string; size: number; fileName?: string }) =>
  api().post("/api/media/upload-url").set(auth(user)).send(body);

// Parcours complet : URL d'envoi → PUT direct vers MinIO → enregistrement.
async function upload(user: TestUser, { mimeType = "image/png", bytes = PNG, fileName }: { mimeType?: string; bytes?: Buffer; fileName?: string } = {}) {
  const ask = await askUploadUrl(user, { mimeType, size: bytes.length, fileName });
  expect(ask.status).toBe(200);
  const put = await fetch(ask.body.uploadUrl, { method: "PUT", headers: ask.body.headers, body: bytes });
  expect(put.status).toBe(200);
  const registered = await api().post("/api/media").set(auth(user)).send({ objectKey: ask.body.objectKey, fileName });
  expect(registered.status).toBe(201);
  return registered.body.media as { id: string; mimeType: string; size: number; fileName: string | null };
}

const readUrl = (user: TestUser, mediaId: string) => api().get(`/api/media/${mediaId}/url`).set(auth(user));

async function aliceAndBob() {
  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const conversation = await startConversationByPhone(alice.id, bob.phone);
  return { alice, bob, conversationId: conversation!.id };
}

// ---------------------------------------------------------------------------

describe("POST /api/media/upload-url : le backend vérifie avant de signer", () => {
  it("exige d'être connecté", async () => {
    const res = await api().post("/api/media/upload-url").send({ mimeType: "image/png", size: 10 });
    expect(res.status).toBe(401);
  });

  it("refuse les types non autorisés", async () => {
    const alice = await createUser("Alice");
    const res = await askUploadUrl(alice, { mimeType: "application/x-msdownload", size: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Type de fichier non autorisé");
  });

  it("applique les limites de taille par catégorie", async () => {
    const alice = await createUser("Alice");

    const image = await askUploadUrl(alice, { mimeType: "image/jpeg", size: 16 * MB + 1 });
    const video = await askUploadUrl(alice, { mimeType: "video/mp4", size: 64 * MB + 1 });
    const doc = await askUploadUrl(alice, { mimeType: "application/pdf", size: 100 * MB + 1 });
    const docAtLimit = await askUploadUrl(alice, { mimeType: "application/pdf", size: 100 * MB });
    const videoAtLimit = await askUploadUrl(alice, { mimeType: "video/mp4", size: 64 * MB });

    expect(image.status).toBe(400);
    expect(image.body.error).toBe("Fichier trop volumineux : Images limitées à 16 Mo");
    expect(video.status).toBe(400);
    expect(doc.status).toBe(400);
    expect(docAtLimit.status).toBe(200);
    expect(videoAtLimit.status).toBe(200);
  });

  it("renvoie une URL PUT présignée de 5 minutes, sous mon préfixe", async () => {
    const alice = await createUser("Alice");
    // Le paramètre ";codecs=opus" de MediaRecorder est retiré.
    const res = await askUploadUrl(alice, { mimeType: "audio/webm;codecs=opus", size: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.objectKey).toMatch(new RegExp(`^users/${alice.id}/[0-9a-f-]{36}$`));
    expect(res.body.expiresIn).toBe(300);
    expect(res.body.headers).toEqual({ "Content-Type": "audio/webm" });
    const url = new URL(res.body.uploadUrl);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });
});

describe("envoi direct vers MinIO", () => {
  it("parcours complet : PUT direct, enregistrement, relecture des mêmes octets", async () => {
    const alice = await createUser("Alice");

    const media = await upload(alice);

    expect(media).toMatchObject({ mimeType: "image/png", size: PNG.length });
    const row = await prisma.media.findUniqueOrThrow({ where: { id: media.id } });
    expect(row.uploaderId).toBe(alice.id);

    const read = await readUrl(alice, media.id);
    expect(read.status).toBe(200);
    const file = await fetch(read.body.url);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it("MinIO refuse un autre type ou une autre taille que ceux signés (403)", async () => {
    const alice = await createUser("Alice");
    const ask = await askUploadUrl(alice, { mimeType: "image/png", size: PNG.length });

    const otherType = await fetch(ask.body.uploadUrl, { method: "PUT", headers: { "Content-Type": "text/html" }, body: PNG });
    const otherSize = await fetch(ask.body.uploadUrl, {
      method: "PUT",
      headers: ask.body.headers,
      body: Buffer.concat([PNG, Buffer.alloc(1000)]),
    });

    expect(otherType.status).toBe(403);
    expect(otherSize.status).toBe(403);
    expect(await headObject(ask.body.objectKey)).toBeNull(); // rien n'a été stocké
  });

  it("une URL présignée altérée (autre clé) est refusée", async () => {
    const alice = await createUser("Alice");
    const ask = await askUploadUrl(alice, { mimeType: "image/png", size: PNG.length });
    const tampered = ask.body.uploadUrl.replace(alice.id, "00000000-0000-4000-8000-000000000000");

    const put = await fetch(tampered, { method: "PUT", headers: ask.body.headers, body: PNG });

    expect(put.status).toBe(403);
  });
});

describe("POST /api/media : enregistrement après l'envoi", () => {
  it("refuse la clé d'un autre utilisateur", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const ask = await askUploadUrl(alice, { mimeType: "image/png", size: PNG.length });
    await fetch(ask.body.uploadUrl, { method: "PUT", headers: ask.body.headers, body: PNG });

    const res = await api().post("/api/media").set(auth(bob)).send({ objectKey: ask.body.objectKey });

    expect(res.status).toBe(404);
  });

  it("refuse un fichier jamais envoyé", async () => {
    const alice = await createUser("Alice");
    const ask = await askUploadUrl(alice, { mimeType: "image/png", size: PNG.length });

    const res = await api().post("/api/media").set(auth(alice)).send({ objectKey: ask.body.objectKey });

    expect(res.status).toBe(400);
  });

  it("refuse un double enregistrement", async () => {
    const alice = await createUser("Alice");
    const ask = await askUploadUrl(alice, { mimeType: "image/png", size: PNG.length });
    await fetch(ask.body.uploadUrl, { method: "PUT", headers: ask.body.headers, body: PNG });

    const first = await api().post("/api/media").set(auth(alice)).send({ objectKey: ask.body.objectKey });
    const second = await api().post("/api/media").set(auth(alice)).send({ objectKey: ask.body.objectKey });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------

describe("messages avec média", () => {
  it("envoie une image : type IMAGE, métadonnées dans le message, reçue par le destinataire", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const media = await upload(alice);
    const aliceSocket = await client(alice);
    const bobSocket = await client(bob);

    const received = waitFor(bobSocket, "message:new");
    const ack = await aliceSocket.emitWithAck("message:send", { conversationId, mediaId: media.id });

    expect(ack.ok).toBe(true);
    expect(ack.message).toMatchObject({ type: "IMAGE", content: null, media: { id: media.id, mimeType: "image/png" } });
    expect(await received).toMatchObject({ id: ack.message.id, type: "IMAGE" });
  });

  it("déduit le type du MIME réel : document, avec son nom", async () => {
    const { alice, conversationId } = await aliceAndBob();
    const media = await upload(alice, { mimeType: "application/pdf", bytes: PDF, fileName: "devis.pdf" });
    const aliceSocket = await client(alice);

    const ack = await aliceSocket.emitWithAck("message:send", { conversationId, mediaId: media.id });

    expect(ack.message).toMatchObject({ type: "DOCUMENT", media: { fileName: "devis.pdf" } });
    // Le lien de lecture d'un document force le téléchargement avec le bon nom.
    const read = await readUrl(alice, media.id);
    const file = await fetch(read.body.url);
    expect(file.headers.get("content-disposition")).toContain("devis.pdf");
  });

  it("refuse le média de quelqu'un d'autre (on ne peut pas s'approprier un fichier)", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const bobsMedia = await upload(bob);
    const aliceSocket = await client(alice);

    const ack = await aliceSocket.emitWithAck("message:send", { conversationId, mediaId: bobsMedia.id });

    expect(ack).toEqual({ ok: false, error: "Média introuvable" });
  });

  it("refuse l'envoi dans une conversation dont on n'est pas membre", async () => {
    const { conversationId } = await aliceAndBob();
    const eve = await createUser("Eve");
    const media = await upload(eve);
    const eveSocket = await client(eve);

    const ack = await eveSocket.emitWithAck("message:send", { conversationId, mediaId: media.id });

    expect(ack).toEqual({ ok: false, error: "Conversation introuvable" });
  });

  it("refuse un message sans texte ni média", async () => {
    const { alice, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice);

    const ack = await aliceSocket.emitWithAck("message:send", { conversationId, content: "   " });

    expect(ack).toEqual({ ok: false, error: "Message vide" });
  });
});

describe("lecture : URL présignée GET seulement pour les membres", () => {
  it("le destinataire peut lire, un tiers reçoit 404", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const eve = await createUser("Eve");
    const media = await upload(alice);
    await (await client(alice)).emitWithAck("message:send", { conversationId, mediaId: media.id });

    const forBob = await readUrl(bob, media.id);
    const forEve = await readUrl(eve, media.id);

    expect(forBob.status).toBe(200);
    expect(new URL(forBob.body.url).searchParams.get("X-Amz-Expires")).toBe("300");
    expect(forEve.status).toBe(404);
  });

  it("avant l'envoi du message, seul l'auteur du fichier peut le lire", async () => {
    const { alice, bob } = await aliceAndBob();
    const media = await upload(alice);

    expect((await readUrl(alice, media.id)).status).toBe(200);
    expect((await readUrl(bob, media.id)).status).toBe(404);
  });

  it("un membre retiré d'un groupe perd l'accès aux médias du groupe", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const carole = await createUser("Carole");
    const group = await api().post("/api/groups").set(auth(alice)).send({ name: "Amis", phones: [bob.phone, carole.phone] });
    const groupId = group.body.conversation.id;
    const media = await upload(alice);
    await (await client(alice)).emitWithAck("message:send", { conversationId: groupId, mediaId: media.id });
    expect((await readUrl(carole, media.id)).status).toBe(200);

    await api().delete(`/api/groups/${groupId}/members/${carole.id}`).set(auth(alice));

    expect((await readUrl(carole, media.id)).status).toBe(404);
    expect((await readUrl(bob, media.id)).status).toBe(200);
  });

  it("un id mal formé donne 404", async () => {
    const alice = await createUser("Alice");
    expect((await readUrl(alice, "pas-un-uuid")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe("photo de profil", () => {
  it("se change avec une image envoyée, et est visible par tout utilisateur", async () => {
    const bob = await createUser("Bob");
    const eve = await createUser("Eve");
    const media = await upload(bob);

    const res = await api().patch("/api/users/me/avatar").set(auth(bob)).send({ mediaId: media.id });

    expect(res.status).toBe(200);
    expect(res.body.user.avatarId).toBe(media.id);
    expect((await readUrl(eve, media.id)).status).toBe(200);
  });

  it("refuse un document, et le média de quelqu'un d'autre", async () => {
    const bob = await createUser("Bob");
    const alice = await createUser("Alice");
    const pdf = await upload(bob, { mimeType: "application/pdf", bytes: PDF, fileName: "cv.pdf" });
    const alicesImage = await upload(alice);

    const doc = await api().patch("/api/users/me/avatar").set(auth(bob)).send({ mediaId: pdf.id });
    const stolen = await api().patch("/api/users/me/avatar").set(auth(bob)).send({ mediaId: alicesImage.id });

    expect(doc.status).toBe(400);
    expect(stolen.status).toBe(404);
  });

  it("peut être retirée", async () => {
    const bob = await createUser("Bob");
    const media = await upload(bob);
    await api().patch("/api/users/me/avatar").set(auth(bob)).send({ mediaId: media.id });

    const res = await api().patch("/api/users/me/avatar").set(auth(bob)).send({ mediaId: null });

    expect(res.body.user.avatarId).toBeNull();
  });
});

describe("photo de groupe", () => {
  async function group() {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const res = await api().post("/api/groups").set(auth(alice)).send({ name: "Amis", phones: [bob.phone] });
    return { alice, bob, groupId: res.body.conversation.id as string };
  }

  it("un admin la change : message système, diffusion et lecture par les membres", async () => {
    const { alice, bob, groupId } = await group();
    const media = await upload(alice);
    const bobSocket = await client(bob);

    const updated = waitFor(bobSocket, "group:updated");
    const res = await api().patch(`/api/groups/${groupId}/photo`).set(auth(alice)).send({ mediaId: media.id });

    expect(res.status).toBe(200);
    expect(res.body.photoId).toBe(media.id);
    expect((await updated).photoId).toBe(media.id);
    const last = await prisma.message.findFirst({ where: { conversationId: groupId }, orderBy: { createdAt: "desc" } });
    expect(last?.content).toBe("Alice a changé la photo du groupe");
    expect((await readUrl(bob, media.id)).status).toBe(200);
  });

  it("un membre non admin ne peut pas la changer", async () => {
    const { bob, groupId } = await group();
    const media = await upload(bob);

    const res = await api().patch(`/api/groups/${groupId}/photo`).set(auth(bob)).send({ mediaId: media.id });

    expect(res.status).toBe(403);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    expect(conversation.photoId).toBeNull();
  });
});
