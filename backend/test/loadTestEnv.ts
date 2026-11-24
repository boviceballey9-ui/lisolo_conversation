import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Charge le .env racine puis redirige DATABASE_URL vers la base de TEST,
// pour ne jamais toucher aux données de développement.
export function loadTestEnv(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, "../../.env");
  dotenv.config({ path: envPath });

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL manquant dans le .env (voir .env.example)");
  }
  // Garde-fou : on compare avec la valeur du FICHIER .env, car process.env.DATABASE_URL
  // a peut-être déjà été redirigé (les workers Vitest héritent de l'environnement du globalSetup).
  const devUrl = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)).DATABASE_URL : undefined;
  if (testUrl === devUrl) {
    throw new Error("TEST_DATABASE_URL doit être différente de DATABASE_URL (les tests vident la base)");
  }

  process.env.DATABASE_URL = testUrl;
  process.env.BCRYPT_ROUNDS = "4"; // hachage rapide en test
  return testUrl;
}
