// Configuration lue depuis les variables d'environnement (.env).
// Les secrets sont obligatoires : sans eux, le serveur refuse de démarrer
// plutôt que de signer des tokens avec une valeur vide.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  }
  return value;
}

export const config = {
  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET"),
    refreshSecret: required("JWT_REFRESH_SECRET"),
    accessExpiresIn: "15m",
    refreshExpiresIn: "7d",
  },
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
  turn: {
    host: process.env.TURN_HOST || "localhost", // tel que le NAVIGATEUR le joint
    port: 3478,
    secret: process.env.TURN_SECRET || "", // identifiants temporaires (recommandé)
    user: process.env.TURN_USER || "", // repli : identifiants fixes
    password: process.env.TURN_PASSWORD || "",
    ttlSeconds: 12 * 60 * 60,
  },
  storage: {
    endpoint: process.env.MINIO_ENDPOINT || "http://localhost:9000",
    accessKey: required("MINIO_ROOT_USER"),
    secretKey: required("MINIO_ROOT_PASSWORD"),
    // Getter : en test, loadTestEnv remplace MINIO_BUCKET après le chargement du .env.
    get bucket() {
      return process.env.MINIO_BUCKET || "media";
    },
  },
} as const;
