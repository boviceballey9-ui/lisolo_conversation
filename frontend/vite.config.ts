import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Les appels à /api/... sont transmis tels quels au backend (évite les soucis de CORS).
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
