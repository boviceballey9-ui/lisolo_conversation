// Erreur « métier » avec un code HTTP. Levée par la couche service,
// traduite en réponse HTTP par errorHandler ou en ack d'erreur par le socket.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (message = "Introuvable") => new HttpError(404, message);
export const badRequest = (message: string) => new HttpError(400, message);
// 403 : on sait qui vous êtes (sinon ce serait 401), mais vous n'avez pas le droit de faire ça.
export const forbidden = (message = "Action non autorisée") => new HttpError(403, message);
