import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Les appels à /api/... sont redirigés vers le backend (évite les soucis de CORS).
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
