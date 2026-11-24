import { createECDH, randomBytes } from "node:crypto";
// @ts-expect-error -- pas de types pour http_ece (bibliothèque de chiffrement utilisée par web-push)
import ece from "http_ece";
import type { Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createUser, startServer, waitFor } from "../../test/helpers.js";
import { startConversationByPhone } from "../chat/service.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import webpush from "web-push";
import { buildPayload, pushRequestOptions, type PushTarget } from "../push/service.js";

type TestUser = Awaited<ReturnType<typeof createUser>>;

// Faux service push : enregistre ce qu'on lui envoie au lieu de contacter Google / Mozilla.
const sent: { target: PushTarget; payload: any }[] = [];
let nextStatus = 201;
const fakeSender = async (target: PushTarget, payload: string) => {
  if (nextStatus >= 400) throw Object.assign(new Error("refusé"), { statusCode: nextStatus });
  sent.push({ target, payload: JSON.parse(payload) });
  return { statusCode: nextStatus };
};

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: ClientSocket[] = [];
const api = () => request(server.url);
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  sent.length = 0;
  nextStatus = 201;
  server = await startServer({ pushSender: fakeSender });
});
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await server.close();
});

async function client(user: TestUser) {
  const s = await connect(server.url, user.token);
  sockets.push(s);
  return s;
}

const subscription = (n = 1) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/fake-${n}-${randomBytes(4).toString("hex")}`,
  keys: { p256dh: "BPubKeyFake", auth: "authFake" },
});

// Attend que le faux service push ait reçu `count` notifications (l'envoi est en tâche de fond).
async function waitForPush(count = 1, timeout = 3000) {
  const start = Date.now();
  while (sent.length < count) {
    if (Date.now() - start > timeout) throw new Error(`${count} notification(s) attendue(s), ${sent.length} reçue(s)`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const nothingSentDuring = (ms = 300) => new Promise((r) => setTimeout(r, ms)).then(() => expect(sent).toHaveLength(0));

// ---------------------------------------------------------------------------

describe("abonnements", () => {
  it("fournit la clé publique VAPID (utilisateur connecté)", async () => {
    const alice = await createUser("Alice");
    expect((await api().get("/api/push/vapid-public-key")).status).toBe(401);
    const res = await api().get("/api/push/vapid-public-key").set(auth(alice));
    expect(res.body).toEqual({ publicKey: config.push.publicKey });
  });

  it("enregistre un abonnement, et refuse une adresse non HTTPS", async () => {
    const alice = await createUser("Alice");

    const ok = await api().post("/api/push/subscriptions").set(auth(alice)).send(subscription());
    const http = await api()
      .post("/api/push/subscriptions")
      .set(auth(alice))
      .send({ ...subscription(), endpoint: "http://evil.example/push" });

    expect(ok.status).toBe(201);
    expect(http.status).toBe(400);
    expect(await prisma.pushSubscription.count({ where: { userId: alice.id } })).toBe(1);
  });

  it("un navigateur qui change de compte : l'abonnement suit le nouvel utilisateur", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const sub = subscription();

    await api().post("/api/push/subscriptions").set(auth(alice)).send(sub);
    await api().post("/api/push/subscriptions").set(auth(bob)).send(sub);

    const rows = await prisma.pushSubscription.findMany({ where: { endpoint: sub.endpoint } });
    expect(rows.map((r) => r.userId)).toEqual([bob.id]);
  });

  it("on ne peut supprimer que son propre abonnement", async () => {
    const alice = await createUser("Alice");
    const eve = await createUser("Eve");
    const sub = subscription();
    await api().post("/api/push/subscriptions").set(auth(alice)).send(sub);

    const byEve = await api().delete("/api/push/subscriptions").set(auth(eve)).send({ endpoint: sub.endpoint });
    const byAlice = await api().delete("/api/push/subscriptions").set(auth(alice)).send({ endpoint: sub.endpoint });

    expect(byEve.body).toEqual({ deleted: false });
    expect(byAlice.body).toEqual({ deleted: true });
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe("envoi à chaque nouveau message", () => {
  async function aliceAndBob() {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const conversation = await startConversationByPhone(alice.id, bob.phone);
    await api().post("/api/push/subscriptions").set(auth(bob)).send(subscription(1));
    await api().post("/api/push/subscriptions").set(auth(bob)).send(subscription(2)); // 2 appareils
    return { alice, bob, conversationId: conversation!.id };
  }

  it("destinataire hors ligne : une notification par appareil, avec l'aperçu du texte", async () => {
    const { alice, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice);

    await aliceSocket.emitWithAck("message:send", { conversationId, content: "Tu es dispo samedi ?" });
    await waitForPush(2);

    expect(sent[0].payload).toEqual({
      title: "Alice",
      body: "Tu es dispo samedi ?",
      tag: `conversation-${conversationId}`,
      url: `/?c=${conversationId}`,
      conversationId,
    });
    expect(new Set(sent.map((s) => s.target.endpoint)).size).toBe(2);
  });

  it("destinataire en ligne (un onglet ouvert) : pas de push, il reçoit message:new", async () => {
    const { alice, bob, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice);
    const bobSocket = await client(bob);

    const received = waitFor(bobSocket, "message:new");
    await aliceSocket.emitWithAck("message:send", { conversationId, content: "Coucou" });

    await received;
    await nothingSentDuring();
  });

  it("l'expéditeur n'est jamais notifié de son propre message", async () => {
    const { alice, conversationId } = await aliceAndBob();
    await api().post("/api/push/subscriptions").set(auth(alice)).send(subscription(3));
    const aliceSocket = await client(alice);

    await aliceSocket.emitWithAck("message:send", { conversationId, content: "Coucou" });
    await waitForPush(2);
    await new Promise((r) => setTimeout(r, 200));

    expect(sent.every((s) => !s.target.endpoint.includes("fake-3-"))).toBe(true);
  });

  it("en groupe : titre = nom du groupe, corps = « auteur : texte »", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const group = await api().post("/api/groups").set(auth(alice)).send({ name: "Week-end", phones: [bob.phone] });
    await api().post("/api/push/subscriptions").set(auth(bob)).send(subscription());
    const aliceSocket = await client(alice);

    await aliceSocket.emitWithAck("message:send", { conversationId: group.body.conversation.id, content: "Départ 9 h" });
    await waitForPush(1);

    expect(sent[0].payload).toMatchObject({ title: "Week-end", body: "Alice : Départ 9 h" });
  });

  it("abonnement expiré (410) : supprimé automatiquement", async () => {
    const { alice, conversationId } = await aliceAndBob();
    const aliceSocket = await client(alice);
    nextStatus = 410;

    await aliceSocket.emitWithAck("message:send", { conversationId, content: "Coucou" });

    const start = Date.now();
    while ((await prisma.pushSubscription.count()) > 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe("contenu des notifications", () => {
  const base = { conversationId: "c1", senderName: "Alice", content: null, media: null };

  it("médias : libellé lisible, document avec son nom", () => {
    expect(buildPayload({ ...base, type: "IMAGE" }, null).body).toBe("📷 Photo");
    expect(buildPayload({ ...base, type: "AUDIO" }, null).body).toBe("🎤 Message vocal");
    expect(buildPayload({ ...base, type: "DOCUMENT", media: { fileName: "devis.pdf" } }, null).body).toBe("📄 devis.pdf");
  });

  it("texte long : tronqué", () => {
    const body = buildPayload({ ...base, type: "TEXT", content: "a".repeat(500) }, null).body;
    expect(body).toHaveLength(180);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("chiffrement de bout en bout (vraie bibliothèque web-push)", () => {
  it("la requête envoyée au service push est chiffrée et signée ; seul le navigateur peut la lire", () => {
    // Le « navigateur » : sa paire de clés ECDH P-256 et son secret d'authentification,
    // ceux qu'il publie dans son abonnement (keys.p256dh et keys.auth).
    const browserKeys = createECDH("prime256v1");
    browserKeys.generateKeys();
    const authSecret = randomBytes(16);
    const target = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: browserKeys.getPublicKey("base64url"), auth: authSecret.toString("base64url") },
    };
    const payload = buildPayload({ conversationId: "c1", senderName: "Bob", media: null, type: "TEXT", content: "Secret 🤫" }, null);

    // Exactement la requête que webPushSender enverrait (mêmes options), mais sans réseau.
    const req = webpush.generateRequestDetails(target, JSON.stringify(payload), pushRequestOptions());

    expect(req.method).toBe("POST");
    expect(req.endpoint).toBe(target.endpoint);
    // Chiffré (RFC 8291) : le texte n'apparaît nulle part dans ce que voit le service push.
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Buffer.from(req.body!).toString("latin1")).not.toContain("Secret");
    // Signé avec notre clé VAPID (RFC 8292) : le service push sait qui envoie.
    expect(req.headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${config.push.publicKey}$`));
    expect(req.headers.TTL).toBe(86400);
    // Seul le détenteur de la clé privée du navigateur peut déchiffrer.
    const clear = ece.decrypt(Buffer.from(req.body!), {
      version: "aes128gcm",
      privateKey: browserKeys,
      authSecret: authSecret.toString("base64url"),
    });
    expect(JSON.parse(clear.toString("utf8"))).toEqual(payload);

    // Avec une AUTRE clé de navigateur, impossible de déchiffrer.
    const intruder = createECDH("prime256v1");
    intruder.generateKeys();
    expect(() => ece.decrypt(Buffer.from(req.body!), { version: "aes128gcm", privateKey: intruder, authSecret: authSecret.toString("base64url") })).toThrow();
  });
});
