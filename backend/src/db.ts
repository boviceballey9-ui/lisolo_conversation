import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

// Une seule instance de PrismaClient pour toute l'application
// (chaque instance ouvre son propre pool de connexions PostgreSQL).
// DATABASE_URL doit être chargé (dotenv) avant l'import de ce module.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
