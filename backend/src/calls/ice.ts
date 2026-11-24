// Configuration ICE envoyée au navigateur : où trouver STUN et TURN, avec quels identifiants.
//
// Identifiants TURN TEMPORAIRES (mécanisme « TURN REST API » de coturn) :
//   username   = "<date d'expiration en secondes>:<userId>"
//   credential = base64( HMAC-SHA1(TURN_SECRET, username) )
// coturn connaît le même secret : il refait le calcul et vérifie que la date n'est pas passée.
// Le secret ne quitte jamais le serveur ; un identifiant volé ne sert que jusqu'à son expiration.

import { createHmac } from "node:crypto";
import { config } from "../config.js";

export interface IceConfig {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  ttl: number | null; // durée de validité des identifiants TURN (secondes), null si fixes
}

export function turnCredential(secret: string, username: string) {
  return createHmac("sha1", secret).update(username).digest("base64");
}

export function iceConfigFor(userId: string, now = Date.now()): IceConfig {
  const { host, port, secret, user, password, ttlSeconds } = config.turn;
  const stun = { urls: `stun:${host}:${port}` };
  const turnUrls = [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`];

  if (secret) {
    const username = `${Math.floor(now / 1000) + ttlSeconds}:${userId}`;
    return {
      iceServers: [stun, { urls: turnUrls, username, credential: turnCredential(secret, username) }],
      ttl: ttlSeconds,
    };
  }
  // Repli (pas de TURN_SECRET) : identifiants fixes du .env. Moins sûr : valables pour toujours.
  if (user && password) {
    return { iceServers: [stun, { urls: turnUrls, username: user, credential: password }], ttl: null };
  }
  return { iceServers: [stun], ttl: null }; // STUN seul : marche sur un réseau simple, pas derrière un NAT strict
}
