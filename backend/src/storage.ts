// Accès à MinIO via le SDK S3 d'AWS (MinIO parle le même protocole que Amazon S3).
//
// Le backend ne transporte JAMAIS le contenu des fichiers : il signe des URL temporaires
// (« présignées ») que le navigateur utilise pour parler directement à MinIO.

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

// Durée de validité des URL présignées (envoi comme lecture).
export const PRESIGN_SECONDS = 5 * 60;

const makeClient = (endpoint: string) =>
  new S3Client({
    endpoint,
    region: "us-east-1", // MinIO ignore la région, mais la signature en exige une
    credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
    // URL « http://localhost:9000/media/clé » plutôt que « http://media.localhost:9000/clé » :
    // MinIO n'a pas de sous-domaine par bucket. (Derrière Nginx : « https://<hôte>/media/clé ».)
    forcePathStyle: true,
    // Les versions récentes du SDK ajoutent par défaut une somme de contrôle (CRC32) à chaque envoi,
    // y compris dans les URL présignées : le navigateur ne la fournit pas et l'envoi échoue.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

// Client « interne » : le backend parle directement à MinIO (création du bucket, HEAD, suppression).
export const s3 = makeClient(config.storage.endpoint);

// Clients de SIGNATURE, un par adresse publique (https://localhost, https://192.168.1.42…).
// Signer ne demande aucun accès réseau : l'URL produite pointe vers Nginx, qui la relaie à MinIO
// en conservant l'en-tête Host… sur lequel porte la signature.
const signers = new Map<string, S3Client>();
function signerFor(publicOrigin?: string | null) {
  if (!publicOrigin) return s3; // développement sans Nginx : http://localhost:9000
  let client = signers.get(publicOrigin);
  if (!client) {
    client = makeClient(publicOrigin);
    signers.set(publicOrigin, client);
  }
  return client;
}

const isNotFound = (err: unknown) =>
  err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 404 || err.name === "NotFound");

// Crée le bucket s'il n'existe pas. Il reste PRIVÉ : aucune lecture anonyme,
// tout passe par des URL présignées délivrées après vérification des droits.
export async function ensureBucket(bucket = config.storage.bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Bucket MinIO « ${bucket} » créé`);
  }
}

// URL d'envoi : autorise UN PUT, sur CETTE clé, avec CE type et CETTE taille, pendant 5 minutes.
// Content-Type et Content-Length font partie de la signature : si le navigateur envoie
// autre chose, MinIO refuse (403) sans même nous consulter.
export function presignPut(key: string, mimeType: string, size: number, publicOrigin?: string | null) {
  return getSignedUrl(
    signerFor(publicOrigin),
    new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, ContentType: mimeType, ContentLength: size }),
    { expiresIn: PRESIGN_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) },
  );
}

// URL de lecture : autorise UN GET sur CETTE clé pendant 5 minutes.
// Pour un document, on demande à MinIO de répondre « téléchargement, avec ce nom ».
export function presignGet(
  key: string,
  { fileName, publicOrigin }: { fileName?: string | null; publicOrigin?: string | null } = {},
) {
  const disposition = fileName
    ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    : undefined;
  return getSignedUrl(
    signerFor(publicOrigin),
    new GetObjectCommand({ Bucket: config.storage.bucket, Key: key, ResponseContentDisposition: disposition }),
    { expiresIn: PRESIGN_SECONDS },
  );
}

// Métadonnées réelles de l'objet (null s'il n'existe pas).
export async function headObject(key: string) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return { size: head.ContentLength ?? 0, mimeType: head.ContentType ?? "application/octet-stream" };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
}

// Vide un bucket (utilisé par les tests sur le bucket de test uniquement).
export async function emptyBucket(bucket: string) {
  for (;;) {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length === 0) return;
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
  }
}
