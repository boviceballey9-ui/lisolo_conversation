import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Une seule fois avant tous les tests : crée et migre la base de test.
    globalSetup: ["./test/globalSetup.ts"],
    // Avant chaque fichier de test : pointe DATABASE_URL vers la base de test.
    setupFiles: ["./test/setup.ts"],
    // Les tests partagent une base réelle : on les exécute un fichier à la fois.
    fileParallelism: false,
  },
});
