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
} as const;
