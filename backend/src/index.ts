import "./env.js"; // doit rester le premier import (charge le .env)
import { createApp } from "./app.js";

const port = Number(process.env.BACKEND_PORT) || 4000;
createApp().listen(port, () => {
  console.log(`Backend démarré sur http://localhost:${port}`);
});
