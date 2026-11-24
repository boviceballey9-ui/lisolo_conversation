import request from "supertest";
import { describe, expect, it } from "vitest";
import { createUser } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { markRead, sendMessage } from "../chat/service.js";

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function startConversation(token: string, phone: string) {
  return request(app).post("/api/conversations").set(auth(token)).send({ phone });
}

describe("POST /api/conversations", () => {
  it("démarre une conversation privée à partir d'un numéro", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");

    const res = await startConversation(alice.token, bob.phone);

    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({
      type: "PRIVATE",
      otherUser: { id: bob.id, name: "Bob" },
      lastMessage: null,
      unreadCount: 0,
    });
    expect(res.body.conversation.otherUser).not.toHaveProperty("passwordHash");
  });

  it("renvoie la même conversation si on recommence, dans un sens comme dans l'autre", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");

    const first = await startConversation(alice.token, bob.phone);
    const again = await startConversation(alice.token, bob.phone);
    const reverse = await startConversation(bob.token, alice.phone);

    expect(again.body.conversation.id).toBe(first.body.conversation.id);
    expect(reverse.body.conversation.id).toBe(first.body.conversation.id);
  });

  it("supporte deux créations simultanées sans doublon", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");

    const [a, b] = await Promise.all([startConversation(alice.token, bob.phone), startConversation(bob.token, alice.phone)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.conversation.id).toBe(b.body.conversation.id);
  });

  it("répond 404 pour un numéro inconnu", async () => {
    const alice = await createUser("Alice");
    const res = await startConversation(alice.token, "+33799999999");

    expect(res.status).toBe(404);
  });

  it("refuse une conversation avec soi-même (400)", async () => {
    const alice = await createUser("Alice");
    const res = await startConversation(alice.token, alice.phone);

    expect(res.status).toBe(400);
  });

  it("refuse un numéro mal formé (400)", async () => {
    const alice = await createUser("Alice");
    const res = await startConversation(alice.token, "0612");

    expect(res.status).toBe(400);
  });

  it("exige d'être connecté (401)", async () => {
    const res = await request(app).post("/api/conversations").send({ phone: "+33612345678" });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/conversations", () => {
  it("liste mes conversations avec le dernier message et les non-lus, la plus récente en premier", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const carol = await createUser("Carol");
    const withBob = (await startConversation(alice.token, bob.phone)).body.conversation.id;
    const withCarol = (await startConversation(alice.token, carol.phone)).body.conversation.id;

    await sendMessage(bob.id, { conversationId: withBob, content: "Salut Alice" });
    await sendMessage(bob.id, { conversationId: withBob, content: "Tu es là ?" });
    await sendMessage(carol.id, { conversationId: withCarol, content: "Coucou" });
    await sendMessage(alice.id, { conversationId: withCarol, content: "Hello Carol" });

    const res = await request(app).get("/api/conversations").set(auth(alice.token));

    expect(res.status).toBe(200);
    const [first, second] = res.body.conversations;
    // Carol : activité la plus récente (message d'Alice), 1 non-lu (le « Coucou »).
    expect(first).toMatchObject({
      id: withCarol,
      otherUser: { name: "Carol" },
      lastMessage: { content: "Hello Carol", senderId: alice.id, status: "SENT" },
      unreadCount: 1,
    });
    expect(second).toMatchObject({ id: withBob, lastMessage: { content: "Tu es là ?" }, unreadCount: 2 });
  });

  it("remet le compteur de non-lus à 0 après lecture", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const conversationId = (await startConversation(alice.token, bob.phone)).body.conversation.id;
    await sendMessage(bob.id, { conversationId, content: "Message" });

    await markRead(alice.id, conversationId);
    const res = await request(app).get("/api/conversations").set(auth(alice.token));

    expect(res.body.conversations[0].unreadCount).toBe(0);
  });

  it("ne montre pas les conversations des autres", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const eve = await createUser("Eve");
    await startConversation(alice.token, bob.phone);

    const res = await request(app).get("/api/conversations").set(auth(eve.token));

    expect(res.body.conversations).toEqual([]);
  });
});

describe("GET /api/conversations/:id/messages", () => {
  it("pagine l'historique du plus récent au plus ancien, chaque page en ordre chronologique", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const conversationId = (await startConversation(alice.token, bob.phone)).body.conversation.id;
    for (let i = 1; i <= 35; i++) {
      await sendMessage(i % 2 ? alice.id : bob.id, { conversationId, content: `message ${i}` });
    }

    const page1 = await request(app).get(`/api/conversations/${conversationId}/messages`).set(auth(alice.token));
    expect(page1.status).toBe(200);
    expect(page1.body.messages).toHaveLength(30);
    expect(page1.body.messages[0].content).toBe("message 6");
    expect(page1.body.messages[29].content).toBe("message 35");
    expect(page1.body.nextCursor).toBe(page1.body.messages[0].id);

    const page2 = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .query({ before: page1.body.nextCursor })
      .set(auth(alice.token));
    expect(page2.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "message 1",
      "message 2",
      "message 3",
      "message 4",
      "message 5",
    ]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("respecte le paramètre limit", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const conversationId = (await startConversation(alice.token, bob.phone)).body.conversation.id;
    for (let i = 1; i <= 5; i++) await sendMessage(alice.id, { conversationId, content: `m${i}` });

    const res = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .query({ limit: 2 })
      .set(auth(alice.token));

    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(["m4", "m5"]);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("répond 404 à quelqu'un qui n'est pas dans la conversation", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const eve = await createUser("Eve");
    const conversationId = (await startConversation(alice.token, bob.phone)).body.conversation.id;

    const res = await request(app).get(`/api/conversations/${conversationId}/messages`).set(auth(eve.token));

    expect(res.status).toBe(404);
  });

  it("répond 404 pour un id mal formé et 400 pour un limit invalide", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const conversationId = (await startConversation(alice.token, bob.phone)).body.conversation.id;

    const badId = await request(app).get("/api/conversations/pas-un-uuid/messages").set(auth(alice.token));
    const badLimit = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .query({ limit: 1000 })
      .set(auth(alice.token));

    expect(badId.status).toBe(404);
    expect(badLimit.status).toBe(400);
  });
});
