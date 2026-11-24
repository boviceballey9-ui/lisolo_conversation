import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { config } from "../config.js";

// Derrière Nginx : les URL renvoyées au navigateur (MinIO présigné, TURN) doivent utiliser
// l'adresse par laquelle IL nous a joints… mais seulement si elle est dans la liste blanche.

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const LAN = "192.168.1.42";

let savedOrigins: string | undefined;
beforeAll(() => {
  savedOrigins = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = `http://localhost:5173,https://localhost,https://${LAN}`;
});
afterAll(() => {
  if (savedOrigins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = savedOrigins;
});

// Ce que Nginx ajoute à chaque requête (proxy_set_header X-Forwarded-*).
const viaNginx = (host: string, proto = "https") => ({ "X-Forwarded-Proto": proto, "X-Forwarded-Host": host });

const askUploadUrl = (token: string, headers: Record<string, string> = {}) =>
  request(app)
    .post("/api/media/upload-url")
    .set({ ...auth(token), ...headers })
    .send({ mimeType: "image/png", size: 100 });

describe("URL présignées derrière Nginx", () => {
  it("signe pour l'adresse publique utilisée par le client (téléphone sur le Wi-Fi)", async () => {
    const alice = await createUser("Alice");

    const res = await askUploadUrl(alice.token, viaNginx(LAN));

    expect(res.status).toBe(200);
    // https://<IP>/<bucket>/<clé> (bucket « media » hors tests) : Nginx route /media/ vers MinIO.
    expect(res.body.uploadUrl.startsWith(`https://${LAN}/${config.storage.bucket}/users/${alice.id}/`)).toBe(true);
    // La signature porte sur cet hôte : MinIO la vérifiera avec l'en-tête Host transmis par Nginx.
    expect(new URL(res.body.uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toContain("host");
  });

  it("une adresse hors liste blanche est ignorée (en-tête X-Forwarded-Host falsifié)", async () => {
    const alice = await createUser("Alice");

    const forged = await askUploadUrl(alice.token, viaNginx("evil.example"));
    const plainHttp = await askUploadUrl(alice.token, viaNginx(LAN, "http"));
    const direct = await askUploadUrl(alice.token);

    for (const res of [forged, plainHttp, direct]) {
      expect(res.status).toBe(200);
      expect(res.body.uploadUrl.startsWith(`${config.storage.endpoint}/`)).toBe(true); // repli : MINIO_ENDPOINT
    }
  });
});

describe("configuration ICE derrière Nginx", () => {
  it("annonce coturn à l'adresse par laquelle le navigateur est venu", async () => {
    const alice = await createUser("Alice");

    const viaLan = await request(app).get("/api/calls/ice-config").set({ ...auth(alice.token), ...viaNginx(LAN) });
    const viaLocalhost = await request(app)
      .get("/api/calls/ice-config")
      .set({ ...auth(alice.token), ...viaNginx("localhost") });
    const forged = await request(app)
      .get("/api/calls/ice-config")
      .set({ ...auth(alice.token), ...viaNginx("evil.example") });

    expect(viaLan.body.iceServers[0].urls).toBe(`stun:${LAN}:3478`);
    expect(viaLocalhost.body.iceServers[0].urls).toBe("stun:localhost:3478");
    expect(forged.body.iceServers[0].urls).toBe(`stun:${config.turn.host}:3478`); // repli : TURN_HOST
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    request(app).options("/api/health").set({ Origin: origin, "Access-Control-Request-Method": "GET" });

  it("autorise les origines de la liste (Vite en dev, adresses HTTPS derrière Nginx)", async () => {
    for (const origin of ["http://localhost:5173", "https://localhost", `https://${LAN}`]) {
      const res = await preflight(origin);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("n'autorise pas une origine inconnue", async () => {
    const res = await preflight("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
