import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

// Valide req.body avec un schéma Zod. En cas de succès, req.body est remplacé
// par les données nettoyées (ex. espaces retirés) ; sinon on répond 400.
export function validateBody(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Données invalides",
        details: z.flattenError(result.error).fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}
