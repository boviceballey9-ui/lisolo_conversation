// Types de fichiers acceptés et tailles maximales.
// Le serveur déduit lui-même la catégorie à partir du type MIME : on ne fait jamais
// confiance au client pour dire « ceci est une image ».

export type MediaCategory = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";

const MB = 1024 * 1024;

export const SIZE_LIMITS: Record<MediaCategory, number> = {
  IMAGE: 16 * MB,
  VIDEO: 64 * MB,
  AUDIO: 16 * MB, // messages vocaux
  DOCUMENT: 100 * MB,
};

const ALLOWED: Record<string, MediaCategory> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/gif": "IMAGE",

  "video/mp4": "VIDEO",
  "video/webm": "VIDEO",
  "video/quicktime": "VIDEO",

  "audio/webm": "AUDIO", // MediaRecorder de Chrome / Firefox
  "audio/ogg": "AUDIO",
  "audio/mpeg": "AUDIO",
  "audio/mp4": "AUDIO", // MediaRecorder de Safari
  "audio/aac": "AUDIO",

  "application/pdf": "DOCUMENT",
  "text/plain": "DOCUMENT",
  "text/csv": "DOCUMENT",
  "application/zip": "DOCUMENT",
  "application/msword": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCUMENT",
  "application/vnd.ms-excel": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "DOCUMENT",
  "application/vnd.ms-powerpoint": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "DOCUMENT",
  "application/vnd.oasis.opendocument.text": "DOCUMENT",
  "application/vnd.oasis.opendocument.spreadsheet": "DOCUMENT",
  "application/vnd.oasis.opendocument.presentation": "DOCUMENT",
};

// "audio/webm;codecs=opus" → "audio/webm"
export const baseMime = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();

export const categoryOf = (mime: string): MediaCategory | null => ALLOWED[baseMime(mime)] ?? null;

// null si le fichier est acceptable, sinon le message d'erreur à renvoyer.
export function checkFile(mime: string, size: number): string | null {
  const category = categoryOf(mime);
  if (!category) return "Type de fichier non autorisé";
  const limit = SIZE_LIMITS[category];
  if (size > limit) {
    const label = { IMAGE: "Images", VIDEO: "Vidéos", AUDIO: "Messages vocaux", DOCUMENT: "Documents" }[category];
    return `Fichier trop volumineux : ${label} limitées à ${limit / MB} Mo`;
  }
  if (size <= 0) return "Fichier vide";
  return null;
}
