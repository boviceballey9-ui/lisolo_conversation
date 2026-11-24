// Par quelle adresse publique le client nous a-t-il joints ?
//
// Derrière Nginx, le navigateur peut venir de https://localhost, https://127.0.0.1 ou
// https://192.168.1.42 (téléphone sur le Wi-Fi). Les URL qu'on lui renvoie (URL présignées
// MinIO, serveur TURN) doivent utiliser CETTE adresse, sinon il ne pourra pas les joindre
// (et pour MinIO, la signature porte sur l'hôte : un autre hôte = signature invalide).
//
// Nginx transmet l'adresse d'origine dans X-Forwarded-Proto / X-Forwarded-Host. Ces en-têtes
// peuvent être falsifiés par un client qui contacterait le backend directement : on n'accepte
// donc qu'une adresse de la liste blanche (CORS_ORIGINS en https://). Sinon : null, et
// l'appelant utilise la configuration par défaut (développement sans Nginx).

import type { Request } from "express";
import { config } from "./config.js";

export function publicOriginOf(req: Request): string | null {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (proto !== "https" || !host) return null;
  const origin = `https://${host}`.toLowerCase();
  return config.publicOrigins.includes(origin) ? origin : null;
}

// Juste le nom d'hôte, sans port ni crochets IPv6 (pour l'URL TURN).
export function publicHostOf(req: Request): string | null {
  const origin = publicOriginOf(req);
  return origin ? new URL(origin).hostname.replace(/^\[|\]$/g, "") : null;
}
