import jwt from "jsonwebtoken";
import { config } from "../config.js";

type TokenType = "access" | "refresh";

interface TokenPayload {
  sub: string; // id de l'utilisateur
  type: TokenType;
}

function sign(userId: string, type: TokenType): string {
  const secret = type === "access" ? config.jwt.accessSecret : config.jwt.refreshSecret;
  const expiresIn = type === "access" ? config.jwt.accessExpiresIn : config.jwt.refreshExpiresIn;
  return jwt.sign({ type }, secret, { subject: userId, expiresIn, algorithm: "HS256" });
}

// Renvoie l'id de l'utilisateur si le token est valide, sinon lève une erreur
// (signature invalide, expiré, mauvais type...).
function verify(token: string, type: TokenType): string {
  const secret = type === "access" ? config.jwt.accessSecret : config.jwt.refreshSecret;
  // On impose l'algorithme : sans ça, un token forgé pourrait en choisir un autre.
  const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Partial<TokenPayload>;
  if (payload.type !== type || typeof payload.sub !== "string") {
    throw new Error("Type de token invalide");
  }
  return payload.sub;
}

export const signAccessToken = (userId: string) => sign(userId, "access");
export const signRefreshToken = (userId: string) => sign(userId, "refresh");
export const verifyAccessToken = (token: string) => verify(token, "access");
export const verifyRefreshToken = (token: string) => verify(token, "refresh");
