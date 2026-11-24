import { afterAll, beforeEach } from "vitest";
import { loadTestEnv } from "./loadTestEnv.js";

// Doit s'exécuter AVANT l'import de src/db.ts (qui lit DATABASE_URL) :
// les setupFiles de Vitest passent avant les imports des fichiers de test.
loadTestEnv();

const { prisma } = await import("../src/db.js");

// Chaque test part d'une base vide. CASCADE vide aussi les tables liées.
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "message_status", "messages", "participants", "conversations", "users", "media" CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
