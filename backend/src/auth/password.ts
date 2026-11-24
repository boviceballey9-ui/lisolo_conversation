import bcrypt from "bcrypt";
import { config } from "../config.js";

export function hashPassword(password: string): Promise<string> {
  // Le sel aléatoire est généré par bcrypt et stocké dans le hash lui-même.
  return bcrypt.hash(password, config.bcryptRounds);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Hash d'un mot de passe quelconque, utilisé quand le téléphone n'existe pas :
// on fait quand même une comparaison bcrypt pour que le temps de réponse
// ne révèle pas si un compte existe.
export const DUMMY_HASH = bcrypt.hashSync("mot-de-passe-factice", config.bcryptRounds);
