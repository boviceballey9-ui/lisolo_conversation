import path from "node:path";
import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

// Le .env est à la racine du projet, pas dans backend/.
dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
