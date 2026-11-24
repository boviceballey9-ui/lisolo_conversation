import { afterAll, beforeEach } from "vitest";
import { loadTestEnv } from "./loadTestEnv.js";

// Doit s'exécuter AVANT l'import de src/db.ts (qui lit DATABASE_URL) :
// les setupFiles de Vitest passent avant les imports des fichiers de test.
loadTestEnv();

const { prisma } = await import("../src/db.js");

const TRUNCATE =
  'TRUNCATE TABLE "message_status", "messages", "participants", "conversations", "users", "media", "calls" CASCADE';

// Interblocage PostgreSQL (40P01) : la transaction a été annulée, on peut la rejouer.
const isDeadlock = (err: unknown) => /40P01|deadlock detected/.test(JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));

// Chaque test part d'une base vide. CASCADE vide aussi les tables liées.
//
// Le serveur du test précédent peut encore finir un travail asynchrone (last_seen_at écrit
// à la déconnexion, appel clôturé…) au moment où ce TRUNCATE, qui verrouille toutes les
// tables, démarre : PostgreSQL détecte alors un interblocage et annule l'une des deux
// transactions. Vu en CI (GitHub Actions), pas en local : question de timing. On rejoue
// simplement le TRUNCATE, l'autre transaction ayant eu le temps de se terminer.
beforeEach(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(TRUNCATE);
      return;
    } catch (err) {
      if (!isDeadlock(err) || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
