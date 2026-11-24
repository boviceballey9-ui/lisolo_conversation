import { execSync } from "node:child_process";
import pg from "pg";
import { loadTestEnv } from "./loadTestEnv.js";

// Exécuté une fois avant toute la suite : crée la base de test si besoin
// et y applique les migrations Prisma.
export default async function globalSetup() {
  const testUrl = loadTestEnv();
  const url = new URL(testUrl);
  const dbName = url.pathname.slice(1);

  // On se connecte à la base "postgres" pour pouvoir créer la base de test.
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "inherit",
  });
}
