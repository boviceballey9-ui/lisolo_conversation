import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { config } from "../config.js";
import { prisma } from "../db.js";

const app = createApp();

const alice = { phone: "+33612345678", name: "Alice", password: "motdepasse123" };

async function register(user = alice) {
  return request(app).post("/api/auth/register").send(user);
}

async function login(phone = alice.phone, password = alice.password) {
  return request(app).post("/api/auth/login").send({ phone, password });
}

describe("POST /api/auth/register", () => {
  it("crée un compte et renvoie l'utilisateur + les tokens", async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ phone: alice.phone, name: alice.name });
    expect(res.body.user).not.toHaveProperty("passwordHash");
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it("stocke un hash bcrypt, jamais le mot de passe en clair", async () => {
    await register();
    const user = await prisma.user.findUniqueOrThrow({ where: { phone: alice.phone } });

    expect(user.passwordHash).not.toBe(alice.password);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/); // préfixe d'un hash bcrypt
  });

  it("refuse un numéro déjà utilisé (409)", async () => {
    await register();
    const res = await register({ ...alice, name: "Autre" });

    expect(res.status).toBe(409);
  });

  it.each([
    ["téléphone mal formé", { ...alice, phone: "0612345678" }, "phone"],
    ["nom vide", { ...alice, name: "   " }, "name"],
    ["mot de passe trop court", { ...alice, password: "court" }, "password"],
    ["mot de passe > 72 octets", { ...alice, password: "é".repeat(37) }, "password"],
  ])("refuse les données invalides : %s (400)", async (_label, body, field) => {
    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty(field);
  });
});

describe("POST /api/auth/login", () => {
  it("renvoie les tokens avec le bon mot de passe", async () => {
    await register();
    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe(alice.phone);
    expect(res.body.user).not.toHaveProperty("passwordHash");
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it("met à jour la date de dernière connexion", async () => {
    await register();
    await login();
    const user = await prisma.user.findUniqueOrThrow({ where: { phone: alice.phone } });

    expect(user.lastSeenAt).toBeInstanceOf(Date);
  });

  it("répond la même erreur 401 pour un mauvais mot de passe et un numéro inconnu", async () => {
    await register();
    const wrongPassword = await login(alice.phone, "mauvais-mot-de-passe");
    const unknownPhone = await login("+33700000000", alice.password);

    expect(wrongPassword.status).toBe(401);
    expect(unknownPhone.status).toBe(401);
    // Même message : on ne révèle pas si le numéro a un compte.
    expect(wrongPassword.body).toEqual(unknownPhone.body);
  });
});

describe("POST /api/auth/refresh", () => {
  it("renvoie un nouvel access token utilisable", async () => {
    const { body } = await register();
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: body.refreshToken });

    expect(res.status).toBe(200);
    const me = await request(app).get("/api/users/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("refuse un access token à la place d'un refresh token (401)", async () => {
    const { body } = await register();
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: body.accessToken });

    expect(res.status).toBe(401);
  });

  it("refuse un refresh token falsifié (401)", async () => {
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: "pas.un.jwt" });

    expect(res.status).toBe(401);
  });

  it("refuse le refresh token d'un compte supprimé (401)", async () => {
    const { body } = await register();
    await prisma.user.delete({ where: { id: body.user.id } });
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: body.refreshToken });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/users/me", () => {
  it("renvoie mon profil avec un access token valide", async () => {
    const { body } = await register();
    const res = await request(app).get("/api/users/me").set("Authorization", `Bearer ${body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: body.user.id, phone: alice.phone, name: alice.name });
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("refuse une requête sans token (401)", async () => {
    const res = await request(app).get("/api/users/me");

    expect(res.status).toBe(401);
  });

  it("refuse un refresh token utilisé comme access token (401)", async () => {
    const { body } = await register();
    const res = await request(app).get("/api/users/me").set("Authorization", `Bearer ${body.refreshToken}`);

    expect(res.status).toBe(401);
  });

  it("refuse un token expiré (401)", async () => {
    const { body } = await register();
    // Token signé avec le bon secret mais expiré depuis 10 secondes.
    const expired = jwt.sign(
      { type: "access", exp: Math.floor(Date.now() / 1000) - 10 },
      config.jwt.accessSecret,
      { subject: body.user.id },
    );
    const res = await request(app).get("/api/users/me").set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
  });

  it("refuse un token signé avec un autre secret (401)", async () => {
    const { body } = await register();
    const forged = jwt.sign({ type: "access" }, "secret-de-pirate", { subject: body.user.id, expiresIn: "15m" });
    const res = await request(app).get("/api/users/me").set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });
});
