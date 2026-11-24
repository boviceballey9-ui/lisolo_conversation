// Envoi et lecture des fichiers.
//
// Le fichier ne passe JAMAIS par notre backend :
//   1. le backend nous donne une URL présignée (après avoir vérifié type et taille) ;
//   2. le navigateur envoie le fichier directement à MinIO avec cette URL ;
//   3. on prévient le backend, qui vérifie l'objet et crée la ligne `media`.

import { useEffect, useState } from "react";
import { getMediaUrl, registerMedia, requestUploadUrl, type MediaInfo } from "./api";

// Certains fichiers arrivent sans type MIME (selon le système) : on le devine par l'extension.
const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  mov: "video/quicktime",
};

export function mimeOf(file: Blob & { name?: string }) {
  if (file.type) return file.type.split(";")[0].trim().toLowerCase();
  const ext = file.name?.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "application/octet-stream";
}

export type MediaKind = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";

export const kindOf = (mime: string): MediaKind =>
  mime.startsWith("image/") ? "IMAGE" : mime.startsWith("video/") ? "VIDEO" : mime.startsWith("audio/") ? "AUDIO" : "DOCUMENT";

// PUT direct vers MinIO. XMLHttpRequest plutôt que fetch : seul XHR donne la progression de l'ENVOI.
function putWithProgress(url: string, headers: Record<string, string>, body: Blob, onProgress: (ratio: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Envoi refusé par le stockage (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Stockage injoignable"));
    xhr.send(body);
  });
}

export async function uploadFile(file: File, onProgress: (ratio: number) => void = () => {}): Promise<MediaInfo> {
  const mimeType = mimeOf(file);
  const ticket = await requestUploadUrl(mimeType, file.size, file.name); // 1. le backend vérifie et signe
  await putWithProgress(ticket.uploadUrl, ticket.headers, file, onProgress); // 2. direct vers MinIO
  return registerMedia(ticket.objectKey, file.name); // 3. le backend vérifie l'objet et l'enregistre
}

// ---------- Lecture ----------

// Une balise <img> ne peut pas envoyer notre en-tête Authorization : on demande au backend
// une URL présignée (valable 5 min), mise en cache pour ne pas la redemander à chaque rendu.
const cache = new Map<string, { url: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();
const MARGIN_MS = 30_000; // on renouvelle un peu avant l'expiration

function fetchUrl(mediaId: string): Promise<string> {
  const cached = cache.get(mediaId);
  if (cached && cached.expiresAt - Date.now() > MARGIN_MS) return Promise.resolve(cached.url);
  let pending = inFlight.get(mediaId);
  if (!pending) {
    pending = getMediaUrl(mediaId)
      .then(({ url, expiresAt }) => {
        cache.set(mediaId, { url, expiresAt: new Date(expiresAt).getTime() });
        return url;
      })
      .finally(() => inFlight.delete(mediaId));
    inFlight.set(mediaId, pending);
  }
  return pending;
}

export function useMediaUrl(mediaId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (mediaId ? (cache.get(mediaId)?.url ?? null) : null));

  useEffect(() => {
    if (!mediaId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetchUrl(mediaId)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setUrl(null)); // pas le droit (404) ou stockage injoignable
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  return url;
}

// Ouvre la version la plus fraîche (l'URL affichée a pu expirer depuis).
export async function openMedia(mediaId: string) {
  cache.delete(mediaId);
  window.open(await fetchUrl(mediaId), "_blank", "noopener");
}
