import { z } from "zod";

// Format international E.164 : "+" puis 7 à 15 chiffres, sans espaces (ex. +33612345678).
const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "Numéro au format international attendu, ex. +33612345678");

// bcrypt ne prend en compte que les 72 premiers octets : on refuse au-delà
// pour éviter qu'un mot de passe plus long soit tronqué en silence.
const password = z
  .string()
  .min(8, "8 caractères minimum")
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "72 octets maximum");

export const registerSchema = z.object({
  phone,
  name: z.string().trim().min(1, "Nom obligatoire").max(64, "64 caractères maximum"),
  password,
});

export const loginSchema = z.object({
  phone,
  password: z.string().min(1, "Mot de passe obligatoire"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token obligatoire"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
