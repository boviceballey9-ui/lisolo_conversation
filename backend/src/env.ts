import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Charge le .env situé à la racine du projet.
// Ce module doit être importé EN PREMIER : en ESM, tous les imports sont évalués
// avant le code du fichier, donc un dotenv.config() placé dans index.ts arriverait
// trop tard pour db.ts.
// "../../.env" fonctionne depuis src/ (tsx) comme depuis dist/ (après build).
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });
